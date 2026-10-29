//! Running the Mac's own `git`, and `gh` to make a repository, for vault sync (U-29).
//!
//! The host runs a program named `git` (or `gh`) from a fixed list of places,
//! with arguments in one of the shapes `shapes.rs` holds, in the open vault's
//! folder, with no shell, a minimal environment and a time limit, and hands
//! back what it printed. What the output means — status, conflicts, what to
//! do next — is decided in TypeScript (ADR-0005). DFAI keeps no GitHub
//! credentials: `git` and `gh` use the login already on the Mac.
//!
//! The webview is the untrusted side (ADR-0017), so, as with Claude Code
//! (ADR-0021), the host holds the shapes and refuses anything else before
//! anything runs.

mod shapes;

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::vault::{
    change_in_vault, git_write_turn, location_of, root_for_write, VaultLocation, VaultState,
};
pub use shapes::Reach;
use shapes::{
    clone_name, clone_url, new_remote_url, overwritten_path, remote_settings_branch,
    vet_folder_args, vet_repo_name, vet_vault_args, writes_working_tree,
};

/// Where `git` is looked for, in order: Homebrew's, then Apple's.
const GIT_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
/// Where `gh` is looked for: it only comes from Homebrew.
const GH_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];
/// What a child's PATH ends with, after the program folders.
const SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
/// The host's variables a child is handed when the host has them: the ssh
/// agent (for `git@github.com:` remotes), text encoding, the account whose
/// keychain holds a credential helper's login, and the per-user temp folder.
/// `HOME` and `PATH` are set by the host. Nothing else reaches the child.
const PASSED_ENV: &[&str] = &["SSH_AUTH_SOCK", "LANG", "USER", "LOGNAME", "TMPDIR"];
/// Set on every child so nothing ever waits on a prompt nobody can see.
const QUIET_ENV: &[(&str, &str)] = &[
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GCM_INTERACTIVE", "never"),
    ("GH_PROMPT_DISABLED", "1"),
    ("GH_NO_UPDATE_NOTIFIER", "1"),
];
/// Put before every `git` command the webview asks for.
///
/// - `core.hooksPath=/dev/null`: no hook in the vault's `.git` runs.
/// - `core.fsmonitor=false`: config cannot name a program to watch the files.
/// - `core.quotePath=false`: paths come back as they are spelled, for TS to read.
/// - `protocol.ext.allow=never`: an `ext::` remote, which runs a command, is off.
/// - `color.ui=never`: output is text to parse, never escape codes.
/// - `--literal-pathspecs`: a path is a path, never `:(glob)*` or `:!x` magic.
///
/// Then the Mac's own git settings that would change what a sync does, each
/// put back to git's default (A29-01): a commit that must be signed fails
/// without the key, `merge.ff=only` refuses every merge, `core.autocrlf`
/// rewrites a note's line endings, and a merge's conflict style or renames
/// setting would change what a settled conflict holds.
const FIXED_PREFIX: &[&str] = &[
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotePath=false",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "color.ui=never",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "merge.ff=true",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "merge.conflictStyle=merge",
    "-c",
    "merge.renames=true",
    "--literal-pathspecs",
    // A `status` that refreshes the index would take its lock, and a sync's
    // own `add` or `merge` beside it would then fail.
    "--no-optional-locks",
];
/// Where a vault's own excludes file is, inside its `.git`: the folders and
/// files TypeScript decided are left out of sync. It takes the place of the
/// Mac's global excludes file, which would otherwise leave attachments out.
const SYNC_DIR: &str = "atlas-sync";
const EXCLUDES_FILE: &str = "exclude";
/// The files TypeScript may keep in `.git/atlas-sync/`: a settle's journal
/// and the excludes. Nothing else is read or written there.
const SYNC_FILES: &[&str] = &["journal.json", EXCLUDES_FILE];
/// The most a sync file may hold.
const MAX_SYNC_FILE: usize = 1024 * 1024;
/// How the webview is told no program was found, so it can say how to install it.
const NOT_FOUND: &str = "not_found:";
/// How the webview is told the person said no to what it asked for.
const DECLINED: &str = "declined:";
/// How the webview is told a checkout was not run because the file it would
/// write over changed since the sync looked at it: the person saved it.
const CHANGED: &str = "changed:";
/// How the webview is told a folder outside the vault was not one the person picked.
const NOT_CHOSEN: &str = "that folder was not chosen in DFAI";
/// The most of a run's output the host keeps; `status` of a very large vault fits.
const MAX_STDOUT: u64 = 32 * 1024 * 1024;
/// Only the end of stderr is kept, to say why a run failed.
const MAX_STDERR: usize = 8 * 1024;
/// How often a run is checked for having exited.
const EXIT_POLL: Duration = Duration::from_millis(10);

/// What a run printed, as it printed it. `code` is None when it was stopped.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// What the sync saw of the file a checkout writes over, when it looked: the
/// file's blob id, or None when there was no file there.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Seen {
    pub blob: Option<String>,
}

/// One vetted command for the open vault, as the webview asks for it.
pub struct VaultRun<'a> {
    pub state: &'a VaultState,
    /// The vault the command is meant for; refused when another is open.
    pub meant_for: &'a str,
    pub args: &'a [String],
    pub seen: Option<&'a Seen>,
}

/// Asks the person to agree to something only they may allow: connecting the
/// vault to a remote, copying one onto the Mac, or making a GitHub repository.
/// The webview can ask for these, but only the person can say yes (ADR-0017).
pub trait Confirm: Send + Sync {
    fn ask(&self, question: &str, yes: &str) -> bool;
}

/// Says no to everything: the host's default until a command hands it the
/// window's dialog, so nothing is allowed that nobody was asked about.
struct Refuse;

impl Confirm for Refuse {
    fn ask(&self, _question: &str, _yes: &str) -> bool {
        false
    }
}

/// The native OK/Cancel dialog.
struct DialogConfirm(AppHandle);

impl Confirm for DialogConfirm {
    fn ask(&self, question: &str, yes: &str) -> bool {
        self.0
            .dialog()
            .message(question)
            .title("DFAI sync")
            .buttons(MessageDialogButtons::OkCancelCustom(
                yes.to_string(),
                "Cancel".to_string(),
            ))
            .blocking_show()
    }
}

/// How long each kind of run may take before the host stops it.
#[derive(Debug, Clone, Copy)]
struct Limits {
    local: Duration,
    network: Duration,
}

impl Limits {
    fn of(&self, reach: Reach) -> Duration {
        match reach {
            Reach::Local => self.local,
            Reach::Network => self.network,
        }
    }
}

/// Where the programs are looked for, the home folder they are handed, how
/// long they may run, the folders the person picked for a clone, and who is
/// asked before the vault is pointed at a remote.
#[derive(Clone)]
pub struct GitHost {
    git_dirs: Vec<String>,
    gh_dirs: Vec<String>,
    home: Option<PathBuf>,
    limits: Limits,
    /// Folders picked in `git_pick_clone_folder`, canonical; shared by every clone of the host.
    grants: Arc<Mutex<HashSet<PathBuf>>>,
    confirm: Arc<dyn Confirm>,
}

impl Default for GitHost {
    fn default() -> Self {
        Self {
            git_dirs: GIT_DIRS.iter().map(|dir| dir.to_string()).collect(),
            gh_dirs: GH_DIRS.iter().map(|dir| dir.to_string()).collect(),
            home: std::env::var_os("HOME").map(PathBuf::from),
            limits: Limits {
                // Generous: a first `add --all` of a large vault whose files
                // iCloud downloads as they are read must not be cut off.
                local: Duration::from_secs(10 * 60),
                network: Duration::from_secs(180),
            },
            grants: Arc::default(),
            confirm: Arc::new(Refuse),
        }
    }
}

/// One program run: what it is, where, with what, for how long.
struct Run<'a> {
    name: &'static str,
    dirs: &'a [String],
    cwd: &'a Path,
    args: Vec<String>,
    limit: Duration,
    /// Where git stops looking for a repository, for a run in the vault.
    ceiling: Option<PathBuf>,
}

impl GitHost {
    /// The same host, asking the person through `confirm`.
    fn confirming(&self, confirm: Arc<dyn Confirm>) -> Self {
        Self {
            confirm,
            ..self.clone()
        }
    }

    /// Remembers a folder the person picked, so a clone may go into it.
    pub fn grant(&self, folder: &Path) -> Result<PathBuf, String> {
        let canonical = folder
            .canonicalize()
            .map_err(|error| format!("{} cannot be used: {error}", folder.display()))?;
        lock(&self.grants).insert(canonical.clone());
        Ok(canonical)
    }

    fn is_granted(&self, canonical: &Path) -> bool {
        lock(&self.grants).contains(canonical)
    }

    /// The folder as the disk spells it — links resolved, `/var` as
    /// `/private/var` — for the open vault as it was opened, or a folder the
    /// person picked; any other is refused alike, existing or not, so this
    /// says nothing about the disk beyond those. Resolving only: comparing
    /// the two is TypeScript's (ADR-0005).
    pub fn on_disk(&self, folder: &Path, vault_root: Option<&Path>) -> Result<PathBuf, String> {
        let canonical = folder.canonicalize().ok();
        let is_vault = vault_root == Some(folder);
        let picked = canonical
            .as_deref()
            .is_some_and(|real| self.is_granted(real));
        if !is_vault && !picked {
            return Err(NOT_CHOSEN.to_string());
        }
        canonical.ok_or_else(|| format!("{} cannot be used", folder.display()))
    }

    /// Asks the person; refuses with `declined:` and `why` when they say no.
    fn agree(&self, question: &str, yes: &str, why: String) -> Result<(), String> {
        if self.confirm.ask(question, yes) {
            Ok(())
        } else {
            Err(format!("{DECLINED} {why}"))
        }
    }

    /// Runs one vetted command in the open vault, refused when that is no
    /// longer the vault it was meant for. A command that rewrites notes checks
    /// inside its turn, as a save does: a switch takes the turn too, so once
    /// it answers nothing more lands in the old vault (#246).
    pub fn git_in_open_vault(&self, run: VaultRun<'_>) -> Result<GitOutput, String> {
        let VaultRun {
            state,
            meant_for,
            args,
            seen,
        } = run;
        if writes_working_tree(args) {
            return change_in_vault(state, Some(meant_for), |root| {
                self.git_in_vault_seen(root, args, seen)
            });
        }
        self.git_in_vault_seen(&root_for_write(state.get(), Some(meant_for))?, args, seen)
    }

    /// Runs one vetted `git` command in the vault at `root`; see `git_in_vault_seen`.
    #[cfg(test)]
    pub fn git_in_vault(&self, root: &Path, args: &[String]) -> Result<GitOutput, String> {
        self.git_in_vault_seen(root, args, None)
    }

    /// Runs one vetted `git` command in the vault at `root`. Pointing the
    /// vault at a remote is asked of the person first. A command that rewrites
    /// notes runs in git's write turn, so no save lands and no read looks while
    /// it writes (#246); on a thread that already holds the change turn it
    /// runs at once. A checkout runs only while its file still holds what the
    /// sync `seen`, as a save lands only on the version it was opened at.
    pub fn git_in_vault_seen(
        &self,
        root: &Path,
        args: &[String],
        seen: Option<&Seen>,
    ) -> Result<GitOutput, String> {
        let reach = vet_vault_args(args)?;
        let overwritten = overwritten_path(args);
        if overwritten.is_some() != seen.is_some() {
            return Err(
                "a checkout, and only a checkout, says what the sync saw of its file".into(),
            );
        }
        if let Some(url) = new_remote_url(args) {
            self.agree(
                &format!("Connect this vault to {url}?"),
                "Connect",
                format!("You cancelled connecting the vault to {url}."),
            )?;
        }
        if let Some(branch) = remote_settings_branch(args) {
            self.refuse_unless_checked_out(root, branch)?;
        }
        let _turn = writes_working_tree(args).then(git_write_turn);
        if let (Some(path), Some(seen)) = (overwritten, seen) {
            self.refuse_if_changed(root, path, seen)?;
        }
        // Taken once the turn is held, so a stopped run's lock check covers
        // the run only, never the time it waited for its turn.
        let started = SystemTime::now();
        let mut full = vec![
            "-c".to_string(),
            format!("core.excludesFile={}", excludes_of(root).display()),
        ];
        full.extend(args.iter().cloned());
        let (output, stopped) = self.git(root, &full, reach, Some(ceiling_of(root)))?;
        if stopped && reach == Reach::Local {
            remove_lock_made_since(root, started);
        }
        Ok(output)
    }

    /// Refuses a read of the settings on GitHub for any branch but the one
    /// checked out, as git itself says it: the other Mac's last word is on that
    /// branch alone (#630).
    fn refuse_unless_checked_out(&self, root: &Path, branch: &str) -> Result<(), String> {
        let asked = ["symbolic-ref", "--quiet", "--short", "HEAD"].map(String::from);
        let checked_out = self.git_in_vault_seen(root, &asked, None)?;
        if checked_out.code == Some(0) && checked_out.stdout.trim_end() == branch {
            Ok(())
        } else {
            Err(format!(
                "origin/{branch} is not the branch checked out, so its settings are not read"
            ))
        }
    }

    /// Refuses with `changed:` when the file at `path` no longer holds what the sync saw.
    fn refuse_if_changed(&self, root: &Path, path: &str, seen: &Seen) -> Result<(), String> {
        if self.blob_of(root, path)? == seen.blob {
            Ok(())
        } else {
            Err(format!(
                "{CHANGED} {path} changed since the sync looked at it"
            ))
        }
    }

    /// The blob id of the file's bytes as they are, as the sync's own
    /// `hash-object` says it; None when there is no file.
    fn blob_of(&self, root: &Path, path: &str) -> Result<Option<String>, String> {
        match root.join(path).symlink_metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("{path} cannot be read: {error}")),
            Ok(_) => {}
        }
        let args: Vec<String> = ["hash-object", "--no-filters", "--", path]
            .iter()
            .map(|arg| arg.to_string())
            .collect();
        let (output, _) = self.git(root, &args, Reach::Local, Some(ceiling_of(root)))?;
        match output.code {
            Some(0) => Ok(Some(output.stdout.trim().to_string())),
            _ => Err(format!("{path} cannot be read: {}", output.stderr.trim())),
        }
    }

    /// Reads one of the vault's sync files in `.git/atlas-sync/`; None when it is not there.
    pub fn read_sync_file(&self, root: &Path, name: &str) -> Result<Option<String>, String> {
        let path = sync_file(root, name)?;
        match fs::read(&path) {
            Ok(bytes) if bytes.len() > MAX_SYNC_FILE => Err(format!("{name} is too large")),
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| format!("{name} is not text")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("{name} cannot be read: {error}")),
        }
    }

    /// Writes one of the vault's sync files whole (through a temporary file,
    /// so a quit never leaves half of one), or removes it for None.
    pub fn write_sync_file(
        &self,
        root: &Path,
        name: &str,
        contents: Option<&str>,
    ) -> Result<(), String> {
        let path = sync_file(root, name)?;
        let Some(contents) = contents else {
            return match fs::remove_file(&path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    Err(format!("{name} cannot be removed: {error}"))
                }
                _ => Ok(()),
            };
        };
        if contents.len() > MAX_SYNC_FILE {
            return Err(format!("{name} is too large"));
        }
        let folder = path.parent().unwrap_or(root);
        fs::create_dir_all(folder).map_err(|error| format!("{name} cannot be written: {error}"))?;
        let temporary = folder.join(format!(".{name}.tmp"));
        fs::write(&temporary, contents)
            .and_then(|()| fs::rename(&temporary, &path))
            .map_err(|error| format!("{name} cannot be written: {error}"))
    }

    /// Lists the GitHub repositories the Mac's `gh` login can see, as JSON,
    /// with the one read-only shape the host holds. It changes nothing.
    pub fn list_repos(&self) -> Result<GitOutput, String> {
        let cwd = self.home.clone().unwrap_or_else(|| PathBuf::from("/"));
        let args = [
            "repo",
            "list",
            "--json",
            "name,nameWithOwner,defaultBranchRef,visibility,url",
            "--limit",
            "1000",
        ];
        let (output, _) = self.run(Run {
            name: "gh",
            dirs: &self.gh_dirs,
            cwd: &cwd,
            args: args.iter().map(|arg| arg.to_string()).collect(),
            limit: self.limits.network,
            ceiling: None,
        })?;
        Ok(output)
    }

    /// Runs `rev-parse --show-toplevel` or a clone in a folder outside the
    /// vault: one the person picked, or (to ask only) the folder above the
    /// open vault.
    pub fn git_in_folder(
        &self,
        folder: &Path,
        args: &[String],
        vault_root: Option<&Path>,
    ) -> Result<GitOutput, String> {
        let reach = vet_folder_args(args)?;
        if !folder.is_absolute() || !folder.is_dir() {
            return Err(format!("{} is not a folder", folder.display()));
        }
        let canonical = folder
            .canonicalize()
            .map_err(|error| format!("{} cannot be used: {error}", folder.display()))?;
        let cloning = clone_name(args);
        let allowed = self.is_granted(&canonical)
            || (cloning.is_none() && above(vault_root).contains(&canonical));
        if !allowed {
            return Err(NOT_CHOSEN.to_string());
        }
        if let Some(name) = cloning {
            if canonical.join(name).symlink_metadata().is_ok() {
                return Err(format!("{name} is already in that folder"));
            }
            let url = clone_url(args).unwrap_or_default();
            self.agree(
                &format!("Copy the vault at {url} to this Mac, into {name}?"),
                "Copy",
                format!("You cancelled copying the vault at {url}."),
            )?;
        }
        Ok(self.git(&canonical, args, reach, None)?.0)
    }

    /// Makes a private GitHub repository from the vault and pushes it, through
    /// `gh`, once the person has agreed to it.
    pub fn create_repo(&self, root: &Path, name: &str) -> Result<GitOutput, String> {
        vet_repo_name(name)?;
        self.agree(
            &format!("Create the private GitHub repository {name} and upload this vault to it?"),
            "Create",
            format!("You cancelled creating the GitHub repository {name}."),
        )?;
        let args = [
            "repo",
            "create",
            name,
            "--private",
            "--source=.",
            "--remote=origin",
            "--push",
        ];
        let (output, _) = self.run(Run {
            name: "gh",
            dirs: &self.gh_dirs,
            cwd: root,
            args: args.iter().map(|arg| arg.to_string()).collect(),
            limit: self.limits.network,
            ceiling: Some(ceiling_of(root)),
        })?;
        Ok(output)
    }

    fn git(
        &self,
        cwd: &Path,
        args: &[String],
        reach: Reach,
        ceiling: Option<PathBuf>,
    ) -> Result<(GitOutput, bool), String> {
        let mut full: Vec<String> = FIXED_PREFIX.iter().map(|arg| arg.to_string()).collect();
        full.extend(args.iter().cloned());
        self.run(Run {
            name: "git",
            dirs: &self.git_dirs,
            cwd,
            args: full,
            limit: self.limits.of(reach),
            ceiling,
        })
    }

    /// Runs the program; says what it printed and whether the host stopped it.
    fn run(&self, run: Run<'_>) -> Result<(GitOutput, bool), String> {
        let (program, path) = locate(run.name, run.dirs)?;
        let mut command = Command::new(program);
        command.env_clear().env("PATH", path);
        if let Some(home) = &self.home {
            command.env("HOME", home);
        }
        for name in PASSED_ENV {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.envs(QUIET_ENV.iter().copied());
        if let Some(ceiling) = &run.ceiling {
            command.env("GIT_CEILING_DIRECTORIES", ceiling);
        }
        if run.name == "gh" {
            // gh runs git itself (`repo create --push`): the same settings
            // as the host's prefix, handed over the way git reads them from
            // its environment, so no hook in the vault runs there either.
            let settings = prefix_settings();
            command.env("GIT_CONFIG_COUNT", settings.len().to_string());
            for (at, (key, value)) in settings.iter().enumerate() {
                command.env(format!("GIT_CONFIG_KEY_{at}"), key);
                command.env(format!("GIT_CONFIG_VALUE_{at}"), value);
            }
        }
        let child = command
            .args(&run.args)
            .current_dir(run.cwd)
            // A group of its own, so a timeout also stops the ssh it started.
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("cannot start {}: {error}", run.name))?;
        Ok(collect(child, run.name, run.limit))
    }
}

/// The folder above the vault, canonical: above the folder it resolves to,
/// and above it as it was opened, which differ for a vault reached through
/// a link (`~/Vault` -> `~/Documents/Vault`). TypeScript asks about the
/// second; both are the vault's own surroundings.
fn above(vault_root: Option<&Path>) -> Vec<PathBuf> {
    let Some(root) = vault_root else {
        return Vec::new();
    };
    let resolved = root
        .canonicalize()
        .ok()
        .and_then(|real| real.parent().map(Path::to_path_buf));
    let as_opened = root.parent().and_then(|parent| parent.canonicalize().ok());
    resolved.into_iter().chain(as_opened).collect()
}

/// The `-c key=value` settings of the fixed prefix, as pairs.
fn prefix_settings() -> Vec<(&'static str, &'static str)> {
    FIXED_PREFIX
        .windows(2)
        .filter(|pair| pair[0] == "-c")
        .filter_map(|pair| pair[1].split_once('='))
        .collect()
}

/// The vault's own excludes file.
fn excludes_of(root: &Path) -> PathBuf {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    root.join(".git").join(SYNC_DIR).join(EXCLUDES_FILE)
}

/// One of the files TypeScript may keep in `.git/atlas-sync/`, in a vault
/// that is a repository of its own (its `.git` a folder, not a link or a
/// pointer to another repository's).
fn sync_file(root: &Path, name: &str) -> Result<PathBuf, String> {
    if !SYNC_FILES.contains(&name) {
        return Err(format!("{name:?} is not a sync file"));
    }
    let git = root.join(".git");
    if !is_real_folder(&git) {
        return Err("the vault is not a repository of its own".to_string());
    }
    let folder = git.join(SYNC_DIR);
    // Not there yet is fine (it is made on the first write); a link is not:
    // it would send the journal and the excludes somewhere else.
    if folder.symlink_metadata().is_ok() && !is_real_folder(&folder) {
        return Err(format!("{} is not a folder of its own", folder.display()));
    }
    let path = folder.join(name);
    if path
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink())
    {
        return Err(format!("{name} is a link, not a sync file"));
    }
    Ok(path)
}

/// A folder, and not a link to one.
fn is_real_folder(path: &Path) -> bool {
    path.symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_dir())
}

/// Removes `index.lock` when a stopped run left it: only a lock made since
/// the run began can be its. An older one is another run's — git in
/// Terminal, say — and is not DFAI's to take away.
fn remove_lock_made_since(root: &Path, started: SystemTime) {
    let lock = root.join(".git").join("index.lock");
    let made = lock
        .symlink_metadata()
        .and_then(|meta| meta.modified())
        .ok();
    if made.is_some_and(|made| made >= started) {
        // Gone meanwhile is what was wanted.
        let _ = fs::remove_file(&lock);
    }
}

/// The folder above the vault, where git stops looking for a repository: a
/// vault that is not a repository of its own is never taken for part of one
/// around it (the DFAI code repository, say), whatever the webview asks.
fn ceiling_of(root: &Path) -> PathBuf {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    root.parent()
        .map_or_else(|| root.clone(), Path::to_path_buf)
}

fn is_executable(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// The first `name` in the folders, and the folders plus the system's as a PATH.
fn locate(name: &str, dirs: &[String]) -> Result<(PathBuf, String), String> {
    let program = dirs
        .iter()
        .map(|dir| Path::new(dir).join(name))
        .find(|candidate| is_executable(candidate))
        .ok_or_else(|| format!("{NOT_FOUND} no {name} in {}", dirs.join(", ")))?;
    let mut path = dirs.to_vec();
    path.push(SYSTEM_PATH.to_string());
    Ok((program, path.join(":")))
}

/// Reads a run to its end, or stops it at `limit`; says whether it stopped it.
fn collect(mut child: Child, name: &str, limit: Duration) -> (GitOutput, bool) {
    let stdout = child
        .stdout
        .take()
        .map(|pipe| thread::spawn(|| read_capped(pipe)));
    let stderr = child
        .stderr
        .take()
        .map(|pipe| thread::spawn(|| read_tail(pipe)));
    let child = Arc::new(Mutex::new(Some(child)));
    let (done, timed_out) = watch(Arc::clone(&child), limit);
    let code = wait(&child);
    drop(done);
    let (stdout, truncated) = stdout
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let mut stderr = stderr
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    if truncated {
        stderr.push_str(&format!("DFAI cut {name}'s output at {MAX_STDOUT} bytes."));
    }
    let stopped = timed_out.recv().unwrap_or(false);
    if stopped {
        stderr.push_str(&format!(
            "DFAI stopped {name}: it ran longer than {limit:?}."
        ));
    }
    let output = GitOutput {
        code: if stopped { None } else { code },
        stdout,
        stderr,
    };
    (output, stopped)
}

/// Stops the run once `limit` has passed, unless the returned sender is
/// dropped first. The receiver says whether it stopped it.
fn watch(
    child: Arc<Mutex<Option<Child>>>,
    limit: Duration,
) -> (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<bool>) {
    let (done, on_done) = channel::<()>();
    let (report, stopped) = channel::<bool>();
    thread::spawn(move || {
        let killed = on_done.recv_timeout(limit) == Err(RecvTimeoutError::Timeout) && kill(&child);
        // The receiver is read once the run has ended; it is there to hear this.
        let _ = report.send(killed);
    });
    (done, stopped)
}

/// Kills the program and its group, if it has not yet been reaped. Holding
/// the lock while it does means the group id cannot belong to anything else.
fn kill(child: &Mutex<Option<Child>>) -> bool {
    let mut held = lock(child);
    let Some(child) = held.as_mut() else {
        return false;
    };
    if let Ok(group) = i32::try_from(child.id()) {
        // SAFETY: kill(2) with a negative pid signals that process group and
        // touches no memory. The group is the child's own (`process_group(0)`)
        // and the child is not yet reaped, so the id is still its.
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
    }
    // Fails only when the program has already exited, which is what was asked.
    let _ = child.kill();
    true
}

/// Waits for the program to exit, taking it out of the slot as it is reaped.
fn wait(child: &Mutex<Option<Child>>) -> Option<i32> {
    loop {
        {
            let mut held = lock(child);
            match held.as_mut()?.try_wait() {
                Ok(Some(status)) => {
                    *held = None;
                    return status.code();
                }
                Ok(None) => {}
                Err(_) => {
                    *held = None;
                    return None;
                }
            }
        }
        thread::sleep(EXIT_POLL);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // A thread that panicked holding the lock left the child as it was.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Stdout up to the cap, and whether there was more. The rest is read and
/// dropped, so the program never blocks on a full pipe.
fn read_capped(pipe: impl Read) -> (String, bool) {
    let mut kept = Vec::new();
    let mut pipe = pipe;
    // A read error ends the output early; the exit code says whether it failed.
    let _ = pipe.by_ref().take(MAX_STDOUT).read_to_end(&mut kept);
    let more = std::io::copy(&mut pipe, &mut std::io::sink()).unwrap_or(0) > 0;
    (String::from_utf8_lossy(&kept).into_owned(), more)
}

fn read_tail(pipe: impl Read) -> String {
    let mut all = Vec::new();
    let mut pipe = pipe;
    // Whatever could be read is what is reported.
    let _ = pipe.read_to_end(&mut all);
    let start = all.len().saturating_sub(MAX_STDERR);
    String::from_utf8_lossy(&all[start..]).into_owned()
}

/// The Mac's name as Sharing shows it, for commit messages and conflict copies.
pub fn mac_name() -> String {
    computer_name()
        .or_else(host_name)
        .unwrap_or_else(|| "this Mac".to_string())
}

fn computer_name() -> Option<String> {
    let output = Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .env_clear()
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !name.is_empty()).then_some(name)
}

fn host_name() -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: gethostname writes at most `len` bytes into the buffer we own.
    let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    if result != 0 {
        return None;
    }
    let end = buffer
        .iter()
        .position(|&byte| byte == 0)
        .unwrap_or(buffer.len());
    let name = String::from_utf8_lossy(&buffer[..end]).to_string();
    let name = name.strip_suffix(".local").unwrap_or(&name).to_string();
    (!name.is_empty()).then_some(name)
}

/// Runs blocking work off the command thread.
async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("the git run did not finish: {error}"))?
}

#[tauri::command]
pub async fn git_run(
    app: AppHandle,
    host: State<'_, GitHost>,
    vault: String,
    args: Vec<String>,
    seen: Option<Seen>,
) -> Result<GitOutput, String> {
    let host = host.confirming(Arc::new(DialogConfirm(app.clone())));
    off_thread(move || {
        host.git_in_open_vault(VaultRun {
            state: &app.state::<VaultState>(),
            meant_for: &vault,
            args: &args,
            seen: seen.as_ref(),
        })
    })
    .await
}

#[tauri::command]
pub async fn git_run_in(
    app: AppHandle,
    state: State<'_, VaultState>,
    host: State<'_, GitHost>,
    folder: String,
    args: Vec<String>,
) -> Result<GitOutput, String> {
    let vault = state.root();
    let host = host.confirming(Arc::new(DialogConfirm(app)));
    off_thread(move || host.git_in_folder(Path::new(&folder), &args, vault.as_deref())).await
}

/// The folder a vault from GitHub is copied into, picked by the person in
/// the native dialog; only such a folder may be cloned into.
#[tauri::command]
pub async fn git_pick_clone_folder(
    app: AppHandle,
    host: State<'_, GitHost>,
) -> Result<Option<VaultLocation>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let folder = picked
        .into_path()
        .map_err(|error| format!("unusable folder: {error}"))?;
    let granted = host.grant(&folder)?;
    Ok(Some(location_of(&granted)))
}

/// The open vault, or a folder picked for a clone, as the disk spells it.
#[tauri::command]
pub async fn git_folder_on_disk(
    state: State<'_, VaultState>,
    host: State<'_, GitHost>,
    folder: String,
) -> Result<String, String> {
    let vault = state.root();
    let host = host.inner().clone();
    off_thread(move || {
        host.on_disk(Path::new(&folder), vault.as_deref())
            .map(|real| real.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
pub async fn gh_repo_create(
    app: AppHandle,
    state: State<'_, VaultState>,
    host: State<'_, GitHost>,
    vault: String,
    name: String,
) -> Result<GitOutput, String> {
    let root = root_for_write(state.get(), Some(&vault))?;
    let host = host.confirming(Arc::new(DialogConfirm(app)));
    off_thread(move || host.create_repo(&root, &name)).await
}

#[tauri::command]
pub async fn this_mac_name() -> Result<String, String> {
    off_thread(|| Ok(mac_name())).await
}

/// Reads one of the open vault's sync files (`journal.json` or `exclude`).
#[tauri::command]
pub async fn git_sync_file_read(
    state: State<'_, VaultState>,
    host: State<'_, GitHost>,
    vault: String,
    name: String,
) -> Result<Option<String>, String> {
    let root = root_for_write(state.get(), Some(&vault))?;
    let host = host.inner().clone();
    off_thread(move || host.read_sync_file(&root, &name)).await
}

/// Writes one of the open vault's sync files whole, or removes it for null.
#[tauri::command]
pub async fn git_sync_file_write(
    state: State<'_, VaultState>,
    host: State<'_, GitHost>,
    vault: String,
    name: String,
    contents: Option<String>,
) -> Result<(), String> {
    let root = root_for_write(state.get(), Some(&vault))?;
    let host = host.inner().clone();
    off_thread(move || host.write_sync_file(&root, &name, contents.as_deref())).await
}

/// The person's GitHub repositories, for Settings → Sync's picker: read-only.
#[tauri::command]
pub async fn gh_repo_list(host: State<'_, GitHost>) -> Result<GitOutput, String> {
    let host = host.inner().clone();
    off_thread(move || host.list_repos()).await
}

#[cfg(test)]
mod tests;
