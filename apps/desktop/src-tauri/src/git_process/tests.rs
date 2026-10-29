//! The host's side of running git for sync: which shapes it runs, what a child
//! is handed, and a real `git` round trip through a bare remote in temp folders.

use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use super::shapes::{
    clone_name, is_url, overwritten_path, vet_folder_args, vet_repo_name, vet_vault_args,
    writes_working_tree, Reach,
};
use super::{
    Confirm, GitHost, GitOutput, Limits, Seen, VaultRun, CHANGED, DECLINED, FIXED_PREFIX, GH_DIRS,
    GIT_DIRS, NOT_CHOSEN, NOT_FOUND,
};
use std::sync::{Arc, Mutex};

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|arg| arg.to_string()).collect()
}

fn vault_ok(list: &[&str]) -> bool {
    vet_vault_args(&args(list)).is_ok()
}

fn folder_ok(list: &[&str]) -> bool {
    vet_folder_args(&args(list)).is_ok()
}

/// Every shape the TypeScript side builds, as it builds them.
const ACCEPTED: &[&[&str]] = &[
    &["rev-parse", "--show-toplevel"],
    &["init", "--quiet", "--initial-branch=main"],
    &[
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
    ],
    &["add", "--all"],
    &[
        "commit",
        "--quiet",
        "--no-verify",
        "-m",
        "DFAI sync from James's Mac 2026-09-28 10:00",
    ],
    &[
        "-c",
        "user.name=DFAI on Work Mac",
        "-c",
        "user.email=atlas@work-mac.local",
        "commit",
        "--quiet",
        "--no-verify",
        "-m",
        "DFAI sync",
    ],
    &["fetch", "--quiet", "origin"],
    &[
        "merge",
        "--no-edit",
        "--allow-unrelated-histories",
        "origin/main",
    ],
    &[
        "-c",
        "user.name=DFAI on Work Mac",
        "-c",
        "user.email=atlas@work-mac.local",
        "merge",
        "--no-edit",
        "--allow-unrelated-histories",
        "origin/main",
    ],
    &["push", "--quiet", "--set-upstream", "origin", "HEAD"],
    &["remote", "get-url", "origin"],
    &[
        "remote",
        "add",
        "origin",
        "https://github.com/james/vault.git",
    ],
    &[
        "remote",
        "set-url",
        "origin",
        "git@github.com:james/vault.git",
    ],
    &["symbolic-ref", "--quiet", "--short", "HEAD"],
    &["log", "-1", "--format=%H%x00%ct"],
    &["log", "-1", "--format=%s", "origin/main", "--"],
    &["checkout", "--ours", "--", "Notes/Ideas.md"],
    &["checkout", "--theirs", "--", "Attachments/photo 1.png"],
    &["config", "--get", "user.name"],
    &["config", "--get", "user.email"],
    &["rev-parse", "--verify", "--quiet", "origin/feature/x"],
    &["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
    &[
        "-c",
        "core.ignoreCase=false",
        "ls-files",
        "-z",
        "--others",
        "--exclude-standard",
    ],
    &["ls-files", "-z", "--stage"],
    &["mv", "--", "idea.md", "idea (conflict from Laptop).md"],
    &["ls-tree", "-r", "-z", "HEAD"],
    &["ls-tree", "-r", "-z", "origin/main"],
    &[
        "ls-tree",
        "-r",
        "-z",
        "0123456789abcdef0123456789abcdef01234567",
    ],
    &["merge-base", "HEAD", "origin/main"],
    &["hash-object", "--no-filters", "--", "Notes/Idea.md"],
    &[
        "cat-file",
        "blob",
        "0123456789abcdef0123456789abcdef01234567",
    ],
    &["cat-file", "blob", "origin/main:.atlas/settings.md"],
    &["cat-file", "blob", "origin/feature/x:.atlas/settings.md"],
    &[
        "update-index",
        "--add",
        "--cacheinfo",
        "100644,0123456789abcdef0123456789abcdef01234567,Idea (conflict from Studio).md",
    ],
    &["checkout-index", "--", "Idea (conflict from Studio).md"],
    &["rm", "--cached", "--quiet", "--", "Attachments/talk.mov"],
    &["reset", "--quiet", "--", "Data/dump.bin"],
    &["reset", "--quiet", "--soft", "origin/main"],
    &[
        "rev-list",
        "--objects",
        "--filter=blob:limit=99614720",
        "--filter-print-omitted",
        "HEAD",
        "--not",
        "--remotes=origin",
    ],
    &["ls-remote", "--symref", "origin", "HEAD"],
    &["branch", "-m", "master"],
];

#[test]
fn every_shape_atlas_runs_in_the_vault_is_accepted() {
    for shape in ACCEPTED {
        assert!(vault_ok(shape), "{shape:?} should be accepted");
    }
}

#[test]
fn only_fetch_push_and_ls_remote_reach_the_network_in_the_vault() {
    for shape in ACCEPTED {
        let reach = vet_vault_args(&args(shape)).unwrap();
        let network = ["fetch", "push", "ls-remote"]
            .iter()
            .any(|verb| shape.contains(verb));
        assert_eq!(reach == Reach::Network, network, "{shape:?}");
    }
}

#[test]
fn a_shape_missing_or_gaining_an_argument_is_refused() {
    for shape in ACCEPTED {
        for cut in 0..shape.len() {
            assert!(!vault_ok(&shape[..cut]), "{:?} is short", &shape[..cut]);
        }
        let mut longer = shape.to_vec();
        longer.push("--upload-pack=touch /tmp/pwned");
        assert!(!vault_ok(&longer), "{longer:?} is long");
    }
}

#[test]
fn reading_a_blob_takes_only_a_blob_id() {
    for refused in [
        &["cat-file", "blob", "HEAD"][..],
        &["cat-file", "blob", "origin/main:secret.md"],
        &["cat-file", "-p", "0123456789abcdef0123456789abcdef01234567"],
        &["cat-file", "--batch"],
        &[
            "cat-file",
            "blob",
            "0123456789ABCDEF0123456789ABCDEF01234567",
        ],
    ] {
        assert!(!vault_ok(refused), "{refused:?}");
    }
}

#[test]
fn every_argument_of_a_shape_refuses_what_it_may_not_hold() {
    // Nothing takes an empty argument: no fixed word is empty, and every value
    // slot refuses one. An option refuses everywhere but after `--`, where a
    // path may begin with a dash and git reads it as a path.
    for shape in ACCEPTED {
        for at in 0..shape.len() {
            let mut changed = shape.to_vec();
            changed[at] = "";
            assert!(!vault_ok(&changed), "{changed:?}");
            if shape[..at].contains(&"--") {
                continue;
            }
            changed[at] = "--exec=sh";
            assert!(!vault_ok(&changed), "{changed:?}");
        }
    }
}

#[test]
fn options_that_run_programs_are_refused_everywhere() {
    for attack in [
        &["fetch", "--upload-pack=sh -c x", "origin"][..],
        &["-c", "core.sshCommand=sh", "fetch", "--quiet", "origin"],
        &["-c", "core.pager=sh", "log", "-1", "--format=%H%x00%ct"],
        &["push", "--quiet", "--receive-pack=sh", "origin", "HEAD"],
        &[
            "clone", "--quiet", "--origin", "origin", "--", "/tmp/x", "y",
        ],
        &["config", "--global", "user.name", "x"],
        &["config", "--get", "core.sshCommand"],
        &["diff", "--output=/tmp/owned"],
        &["log", "-1", "--output=/tmp/owned"],
        &["submodule", "update"],
        &["rebase", "origin/main"],
        &["reset", "--hard", "origin/main"],
    ] {
        assert!(!vault_ok(attack), "{attack:?}");
    }
}

#[test]
fn a_commit_message_is_never_an_option_or_empty_or_endless() {
    let commit = |message: &str| vault_ok(&["commit", "--quiet", "--no-verify", "-m", message]);
    assert!(commit("DFAI sync"));
    assert!(commit("line one\nline two"));
    assert!(!commit(""));
    assert!(!commit("--amend"));
    assert!(!commit("a\0b"));
    assert!(commit(&"x".repeat(1000)));
    assert!(!commit(&"x".repeat(1001)));
}

#[test]
fn an_author_is_only_a_name_and_an_email_without_line_breaks() {
    let with = |name: &str, email: &str| {
        vault_ok(&[
            "-c",
            name,
            "-c",
            email,
            "commit",
            "--quiet",
            "--no-verify",
            "-m",
            "m",
        ])
    };
    assert!(with("user.name=A", "user.email=a@b"));
    assert!(!with("user.name=", "user.email=a@b"));
    assert!(!with("user.name=A", "user.email="));
    assert!(!with("user.name=A\n[core]", "user.email=a@b"));
    assert!(!with("user.email=a@b", "user.name=A"));
    assert!(!with("core.sshCommand=sh", "user.email=a@b"));
    assert!(!with("user.name=A", "core.hooksPath=/tmp"));
}

#[test]
fn a_merge_author_is_only_a_name_and_an_email_without_line_breaks() {
    let with = |name: &str, email: &str| {
        vault_ok(&[
            "-c",
            name,
            "-c",
            email,
            "merge",
            "--no-edit",
            "--allow-unrelated-histories",
            "origin/main",
        ])
    };
    assert!(with("user.name=A", "user.email=a@b"));
    assert!(!with("user.name=", "user.email=a@b"));
    assert!(!with("user.name=A", "user.email="));
    assert!(!with("user.name=A\n[core]", "user.email=a@b"));
    assert!(!with("user.email=a@b", "user.name=A"));
    assert!(!with("core.sshCommand=sh", "user.email=a@b"));
    assert!(!with("user.name=A", "core.hooksPath=/tmp"));
    assert!(!with("user.name=A", "merge.ff=only"));
}

#[test]
fn a_merge_only_takes_a_branch_of_origin() {
    let merge = |reference: &str| {
        vault_ok(&[
            "merge",
            "--no-edit",
            "--allow-unrelated-histories",
            reference,
        ])
    };
    assert!(merge("origin/main"));
    assert!(merge("origin/release-1.2_x"));
    for refused in [
        "main",
        "origin/",
        "origin/-x",
        "origin//x",
        "origin/a..b",
        "origin/x/",
        "origin/../x",
        "upstream/main",
        "--strategy=ours",
        "origin/a b",
        &format!("origin/{}", "b".repeat(201)),
    ] {
        assert!(!merge(refused), "{refused:?}");
    }
}

#[test]
fn a_checkout_path_stays_inside_the_vault_and_out_of_git() {
    let ours = |path: &str| vault_ok(&["checkout", "--ours", "--", path]);
    assert!(ours("Note.md"));
    assert!(ours("Notes/Deep/Idea (conflict from Work Mac).md"));
    assert!(ours(".atlas/settings.md"));
    assert!(ours(".gitignore"));
    for refused in [
        "",
        "/etc/passwd",
        "../outside.md",
        "Notes/../../x",
        "./Note.md",
        "Notes//x.md",
        "Notes/",
        ".git/config",
        "Sub/.GIT/hooks/pre-commit",
        "a\0b",
    ] {
        assert!(!ours(refused), "{refused:?}");
    }
}

#[test]
fn a_remote_is_a_plain_address_never_a_command() {
    for accepted in [
        "https://github.com/james/vault.git",
        "ssh://git@github.com/james/vault.git",
        "git@github.com:james/vault.git",
        "/Volumes/Shared/vault.git",
    ] {
        assert!(is_url(accepted), "{accepted:?}");
    }
    for refused in [
        "",
        "ext::sh -c touch% /tmp/pwned",
        "ext::sh",
        "fd::17",
        "-uhttps://x",
        "--upload-pack=sh",
        "file:///tmp/x",
        "http://github.com/x",
        "relative/path",
        "https://github.com/a b",
        "https://github.com/a\nb",
        "git@github.com:-oProxyCommand=sh",
        "git@:x",
        "@github.com:x",
        "git@git hub.com:x",
        "git@github.com:",
        "transport::https://x",
        "git@github.com:ext::sh",
        &format!("https://{}", "a".repeat(2048)),
    ] {
        assert!(!is_url(refused), "{refused:?}");
        assert!(
            !vault_ok(&["remote", "add", "origin", refused]),
            "{refused:?}"
        );
    }
}

#[test]
fn only_asking_and_cloning_run_outside_the_vault() {
    assert!(folder_ok(&["rev-parse", "--show-toplevel"]));
    let clone = |url: &str, name: &str| {
        folder_ok(&["clone", "--quiet", "--origin", "origin", "--", url, name])
    };
    assert!(clone("git@github.com:james/vault.git", "vault"));
    assert!(!clone("ext::sh -c x", "vault"));
    for name in ["", ".hidden", "-x", "a/b", "..", "a\0b"] {
        assert!(!clone("/tmp/x.git", name), "{name:?}");
    }
    assert_eq!(
        clone_name(&args(&[
            "clone", "--quiet", "--origin", "origin", "--", "/r", "v"
        ])),
        Some("v")
    );
    assert_eq!(clone_name(&args(&["rev-parse", "--show-toplevel"])), None);
    // Nothing that changes a repository runs in a folder that is not the vault.
    for shape in ACCEPTED.iter().filter(|shape| shape[0] != "rev-parse") {
        assert!(!folder_ok(shape), "{shape:?}");
    }
    assert!(!folder_ok(&[
        "clone", "--quiet", "--origin", "origin", "/r", "v"
    ]));
    assert!(!folder_ok(&[
        "clone",
        "--quiet",
        "--origin",
        "origin",
        "--",
        "/r",
        "v",
        "--config=core.sshCommand=sh"
    ]));
}

#[test]
fn a_repository_name_is_githubs_characters_and_never_an_option() {
    for name in ["vault", "James-Vault_2.0", "a"] {
        assert_eq!(vet_repo_name(name), Ok(()), "{name}");
    }
    for name in [
        "",
        "-x",
        ".vault",
        "a b",
        "a/b",
        "--public",
        "vault;rm",
        &"a".repeat(101),
    ] {
        assert!(vet_repo_name(name).is_err(), "{name:?}");
    }
}

#[test]
fn the_fixed_prefix_turns_off_hooks_fsmonitor_and_ext() {
    let prefix = FIXED_PREFIX.join(" ");
    assert!(prefix.contains("-c core.hooksPath=/dev/null"));
    assert!(prefix.contains("-c core.fsmonitor=false"));
    assert!(prefix.contains("-c protocol.ext.allow=never"));
    assert!(prefix.contains("--literal-pathspecs"));
}

#[test]
fn the_programs_are_looked_for_only_in_absolute_folders() {
    for dir in GIT_DIRS.iter().chain(GH_DIRS) {
        assert!(Path::new(dir).is_absolute(), "{dir}");
    }
}

// --- Running a program ---------------------------------------------------

/// A fake program: a shell script with this name, in a folder of its own.
fn fake(name: &str, script: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(name);
    fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    dir
}

const NO_LIMIT: Limits = Limits {
    local: Duration::from_secs(3600),
    network: Duration::from_secs(3600),
};

/// The host, looking for its programs in these folders (the test hook: the
/// webview has no say in where they are looked for).
fn host_in(dirs: &[&Path], home: Option<PathBuf>, limits: Limits) -> GitHost {
    let dirs: Vec<String> = std::iter::once("/nonexistent".to_string())
        .chain(dirs.iter().map(|dir| dir.display().to_string()))
        .collect();
    GitHost {
        git_dirs: dirs.clone(),
        gh_dirs: dirs,
        home,
        limits,
        grants: Arc::default(),
        confirm: Arc::new(Answers::always(true)),
    }
}

/// The person, as a test plays them: says yes or no, and remembers each question.
struct Answers {
    yes: bool,
    asked: Mutex<Vec<String>>,
}

impl Answers {
    fn always(yes: bool) -> Self {
        Self {
            yes,
            asked: Mutex::default(),
        }
    }
}

impl Confirm for Answers {
    fn ask(&self, question: &str, _yes: &str) -> bool {
        self.asked.lock().unwrap().push(question.to_string());
        self.yes
    }
}

/// The host, with the person answering through `answers`.
fn answering(host: GitHost, answers: Arc<Answers>) -> GitHost {
    GitHost {
        confirm: answers,
        ..host
    }
}

#[test]
fn the_child_gets_only_the_environment_it_needs() {
    assert!(std::env::var_os("CARGO_MANIFEST_DIR").is_some());
    let bin = fake("git", "exec /usr/bin/env");
    let home = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    let host = host_in(&[bin.path()], Some(home.path().to_path_buf()), NO_LIMIT);
    let output = host
        .git_in_vault(vault.path(), &args(&["add", "--all"]))
        .unwrap();
    assert_eq!(output.code, Some(0));
    let vars: Vec<(String, String)> = output
        .stdout
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
    let names: HashSet<&str> = vars.iter().map(|(name, _)| name.as_str()).collect();
    // What sh itself sets on the way to `env`.
    let shell = ["PWD", "SHLVL", "_", "OLDPWD"];
    let allowed: HashSet<&str> = [
        "PATH",
        "HOME",
        "SSH_AUTH_SOCK",
        "LANG",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "GIT_TERMINAL_PROMPT",
        "GCM_INTERACTIVE",
        "GH_PROMPT_DISABLED",
        "GH_NO_UPDATE_NOTIFIER",
        "GIT_CEILING_DIRECTORIES",
    ]
    .into_iter()
    .chain(shell)
    .collect();
    assert!(names.is_subset(&allowed), "unexpected: {names:?}");
    let value = |name: &str| {
        vars.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    };
    assert_eq!(value("GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
    assert_eq!(value("GH_PROMPT_DISABLED").as_deref(), Some("1"));
    assert_eq!(value("HOME"), Some(home.path().display().to_string()));
    assert_eq!(
        value("PATH"),
        Some(format!(
            "/nonexistent:{}:/usr/bin:/bin:/usr/sbin:/sbin",
            bin.path().display()
        ))
    );
    assert_eq!(value("CARGO_MANIFEST_DIR"), None);
}

#[test]
fn git_gets_the_fixed_prefix_then_the_vetted_arguments_in_the_vault() {
    let bin = fake("git", "pwd -P\nfor arg in \"$@\"; do echo \"$arg\"; done");
    let vault = tempfile::tempdir().unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    let output = host
        .git_in_vault(vault.path(), &args(&["fetch", "--quiet", "origin"]))
        .unwrap();
    let mut lines = output.stdout.lines();
    assert_eq!(
        lines.next().map(PathBuf::from),
        Some(vault.path().canonicalize().unwrap())
    );
    let rest: Vec<&str> = lines.collect();
    let excludes = format!(
        "core.excludesFile={}",
        vault
            .path()
            .canonicalize()
            .unwrap()
            .join(".git/atlas-sync/exclude")
            .display()
    );
    let mut expected: Vec<&str> = FIXED_PREFIX.to_vec();
    expected.extend(["-c", excludes.as_str(), "fetch", "--quiet", "origin"]);
    assert_eq!(rest, expected);
}

#[test]
fn refused_arguments_run_nothing() {
    let marker = tempfile::tempdir().unwrap();
    let ran = marker.path().join("ran");
    let bin = fake("git", &format!("touch '{}'", ran.display()));
    let vault = tempfile::tempdir().unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    let refused = host.git_in_vault(vault.path(), &args(&["reset", "--hard"]));
    assert!(refused.unwrap_err().contains("not ones DFAI runs git with"));
    host.grant(vault.path()).unwrap();
    let refused = host.git_in_folder(vault.path(), &args(&["add", "--all"]), None);
    assert!(refused.is_err());
    assert!(host.create_repo(vault.path(), "--public").is_err());
    assert!(!ran.exists());
}

#[test]
fn no_program_is_reported_as_not_found() {
    let vault = tempfile::tempdir().unwrap();
    let host = host_in(&[], None, NO_LIMIT);
    let error = host
        .git_in_vault(vault.path(), &args(&["add", "--all"]))
        .unwrap_err();
    assert!(error.starts_with(NOT_FOUND), "{error}");
    let error = host.create_repo(vault.path(), "vault").unwrap_err();
    assert!(error.starts_with(NOT_FOUND), "{error}");
}

#[test]
fn a_file_with_the_name_that_cannot_run_is_not_run() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("git"), "#!/bin/sh\necho ran\n").unwrap();
    let vault = tempfile::tempdir().unwrap();
    let host = host_in(&[dir.path()], None, NO_LIMIT);
    let error = host
        .git_in_vault(vault.path(), &args(&["add", "--all"]))
        .unwrap_err();
    assert!(error.starts_with(NOT_FOUND));
}

#[test]
fn a_run_past_its_limit_is_stopped_and_says_why() {
    let bin = fake("git", "echo started\nexec sleep 30");
    let vault = tempfile::tempdir().unwrap();
    let limits = Limits {
        // Long enough that `echo` has run even when the machine is busy.
        local: Duration::from_secs(2),
        network: Duration::from_secs(3600),
    };
    let host = host_in(&[bin.path()], None, limits);
    let output = host
        .git_in_vault(vault.path(), &args(&["add", "--all"]))
        .unwrap();
    assert_eq!(output.code, None);
    assert_eq!(output.stdout, "started\n");
    assert!(
        output
            .stderr
            .ends_with("DFAI stopped git: it ran longer than 2s."),
        "{}",
        output.stderr
    );
}

#[test]
fn a_network_run_is_held_to_the_network_limit_not_the_local_one() {
    let bin = fake("git", "sleep 0.5\necho done");
    let vault = tempfile::tempdir().unwrap();
    let limits = Limits {
        local: Duration::from_millis(100),
        network: Duration::from_secs(3600),
    };
    let host = host_in(&[bin.path()], None, limits);
    let output = host
        .git_in_vault(vault.path(), &args(&["fetch", "--quiet", "origin"]))
        .unwrap();
    assert_eq!(output.code, Some(0));
    assert_eq!(output.stdout, "done\n");
}

#[test]
fn a_failing_run_reports_its_code_and_the_end_of_stderr() {
    let bin = fake(
        "git",
        "head -c 20000 /dev/zero | tr '\\0' 'e' >&2\necho LAST >&2\nexit 3",
    );
    let vault = tempfile::tempdir().unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    let output = host
        .git_in_vault(vault.path(), &args(&["add", "--all"]))
        .unwrap();
    assert_eq!(output.code, Some(3));
    assert_eq!(output.stderr.len(), 8 * 1024);
    assert!(output.stderr.ends_with("LAST\n"));
}

#[test]
fn a_clone_never_lands_on_something_already_there() {
    let bin = fake("git", "echo ran");
    let parent = tempfile::tempdir().unwrap();
    fs::create_dir(parent.path().join("vault")).unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    host.grant(parent.path()).unwrap();
    let clone = |name: &str| host.git_in_folder(parent.path(), &clone_args(name), None);
    assert!(clone("vault")
        .unwrap_err()
        .contains("already in that folder"));
    assert_eq!(clone("fresh").unwrap().stdout, "ran\n");
    assert!(host
        .git_in_folder(
            Path::new("relative"),
            &args(&["rev-parse", "--show-toplevel"]),
            None,
        )
        .is_err());
    assert!(host
        .git_in_folder(
            &parent.path().join("missing"),
            &args(&["rev-parse", "--show-toplevel"]),
            None,
        )
        .is_err());
}

fn clone_args(name: &str) -> Vec<String> {
    args(&[
        "clone", "--quiet", "--origin", "origin", "--", "/r.git", name,
    ])
}

#[test]
fn a_clone_goes_only_into_a_folder_the_person_picked() {
    let marker = tempfile::tempdir().unwrap();
    let ran = marker.path().join("ran");
    let bin = fake("git", &format!("touch '{}'", ran.display()));
    let picked = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    host.grant(picked.path()).unwrap();
    let error = host
        .git_in_folder(elsewhere.path(), &clone_args("vault"), None)
        .unwrap_err();
    assert_eq!(error, NOT_CHOSEN);
    assert!(!ran.exists());
    // The picked folder named another way — through a link — is still that folder.
    let link = marker.path().join("link");
    std::os::unix::fs::symlink(picked.path(), &link).unwrap();
    host.git_in_folder(&link, &clone_args("vault"), None)
        .unwrap();
    assert!(ran.exists());
}

#[test]
fn asking_where_a_folder_sits_is_allowed_only_above_the_open_vault_or_in_a_picked_folder() {
    let bin = fake("git", "echo asked");
    let parent = tempfile::tempdir().unwrap();
    let vault = parent.path().join("vault");
    fs::create_dir(&vault).unwrap();
    let other = tempfile::tempdir().unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    let ask = |folder: &Path, open: Option<&Path>| {
        host.git_in_folder(folder, &args(&["rev-parse", "--show-toplevel"]), open)
    };
    assert_eq!(ask(parent.path(), Some(&vault)).unwrap().stdout, "asked\n");
    assert_eq!(ask(other.path(), Some(&vault)).unwrap_err(), NOT_CHOSEN);
    assert_eq!(ask(parent.path(), None).unwrap_err(), NOT_CHOSEN);
    // The folder above the vault is for asking only, never for a clone.
    assert_eq!(
        host.git_in_folder(parent.path(), &clone_args("x"), Some(&vault))
            .unwrap_err(),
        NOT_CHOSEN
    );
    host.grant(other.path()).unwrap();
    assert_eq!(ask(other.path(), None).unwrap().stdout, "asked\n");
}

#[test]
fn the_person_is_asked_before_a_remote_a_clone_or_a_repository_and_no_runs_nothing() {
    let marker = tempfile::tempdir().unwrap();
    let ran = marker.path().join("ran");
    let bin = fake("git", &format!("touch '{}'", ran.display()));
    fs::copy(bin.path().join("git"), bin.path().join("gh")).unwrap();
    let vault = tempfile::tempdir().unwrap();
    let picked = tempfile::tempdir().unwrap();
    let no = Arc::new(Answers::always(false));
    let host = answering(host_in(&[bin.path()], None, NO_LIMIT), Arc::clone(&no));
    host.grant(picked.path()).unwrap();
    let url = "git@github.com:james/vault.git";
    for verb in ["add", "set-url"] {
        let error = host
            .git_in_vault(vault.path(), &args(&["remote", verb, "origin", url]))
            .unwrap_err();
        assert_eq!(
            error,
            format!("{DECLINED} You cancelled connecting the vault to {url}.")
        );
    }
    let error = host
        .git_in_folder(picked.path(), &clone_args("vault"), None)
        .unwrap_err();
    assert!(error.starts_with(DECLINED), "{error}");
    let error = host.create_repo(vault.path(), "notes").unwrap_err();
    assert!(error.starts_with(DECLINED), "{error}");
    assert!(!ran.exists(), "something ran without a yes");
    assert_eq!(
        no.asked.lock().unwrap().as_slice(),
        [
            format!("Connect this vault to {url}?"),
            format!("Connect this vault to {url}?"),
            "Copy the vault at /r.git to this Mac, into vault?".to_string(),
            "Create the private GitHub repository notes and upload this vault to it?".to_string(),
        ]
    );

    // A yes lets each one run; nothing else is asked about.
    let yes = Arc::new(Answers::always(true));
    let host = answering(host, Arc::clone(&yes));
    host.git_in_vault(vault.path(), &args(&["remote", "add", "origin", url]))
        .unwrap();
    assert!(ran.exists());
    host.git_in_vault(vault.path(), &args(&["add", "--all"]))
        .unwrap();
    assert_eq!(yes.asked.lock().unwrap().len(), 1);
}

#[test]
fn the_default_host_says_no_to_everything_it_would_have_to_ask() {
    let host = GitHost::default();
    let vault = tempfile::tempdir().unwrap();
    let error = host.create_repo(vault.path(), "notes").unwrap_err();
    assert!(error.starts_with(DECLINED), "{error}");
}

#[test]
fn a_local_run_is_given_ten_minutes() {
    assert_eq!(GitHost::default().limits.local, Duration::from_secs(600));
}

#[test]
fn a_stopped_run_leaves_no_index_lock_behind() {
    let bin = fake(
        "git",
        "mkdir -p .git && touch .git/index.lock && echo locked\nexec sleep 30",
    );
    let vault = tempfile::tempdir().unwrap();
    let limits = Limits {
        local: Duration::from_secs(2),
        network: Duration::from_secs(3600),
    };
    let host = host_in(&[bin.path()], None, limits);
    let output = host
        .git_in_vault(vault.path(), &args(&["add", "--all"]))
        .unwrap();
    assert_eq!(output.stdout, "locked\n");
    assert_eq!(output.code, None);
    assert!(!vault.path().join(".git/index.lock").exists());
}

#[test]
fn a_run_that_ends_by_itself_leaves_git_s_own_lock_alone() {
    let bin = fake("git", "mkdir -p .git && touch .git/index.lock");
    let vault = tempfile::tempdir().unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    ok(host
        .git_in_vault(vault.path(), &args(&["add", "--all"]))
        .unwrap());
    assert!(vault.path().join(".git/index.lock").exists());
}

#[test]
fn git_never_looks_above_the_vault_for_a_repository() {
    let bin = fake("git", "echo \"$GIT_CEILING_DIRECTORIES\"");
    let parent = tempfile::tempdir().unwrap();
    let vault = parent.path().join("vault");
    fs::create_dir(&vault).unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    let output = host.git_in_vault(&vault, &args(&["add", "--all"])).unwrap();
    assert_eq!(
        output.stdout.trim(),
        parent.path().canonicalize().unwrap().display().to_string()
    );
}

#[test]
fn a_vault_inside_another_repository_is_not_taken_for_part_of_it() {
    let Some(git_dir) = real_git_dir() else {
        println!("skipped: no git in {GIT_DIRS:?}");
        return;
    };
    let work = tempfile::tempdir().unwrap();
    let home = work.path().join("home");
    fs::create_dir(&home).unwrap();
    let host = host_in(&[&git_dir], Some(home), NO_LIMIT);
    let outer = work.path().join("code");
    let vault = outer.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let made = Command::new(git_dir.join("git"))
        .args(["init", "--quiet", "--initial-branch=main"])
        .arg(&outer)
        .status()
        .unwrap();
    assert!(made.success());
    fs::write(vault.join("Note.md"), "private\n").unwrap();

    let top = host
        .git_in_vault(&vault, &args(&["rev-parse", "--show-toplevel"]))
        .unwrap();
    assert_ne!(top.code, Some(0), "{top:?}");
    let added = host.git_in_vault(&vault, &args(&["add", "--all"])).unwrap();
    assert_ne!(added.code, Some(0), "{added:?}");
    assert!(
        !outer.join(".git/index").exists(),
        "the outer repository was staged into"
    );
}

#[test]
fn a_half_done_merge_can_be_asked_about() {
    assert!(vault_ok(&[
        "rev-parse",
        "--verify",
        "--quiet",
        "MERGE_HEAD"
    ]));
    assert!(!vault_ok(&[
        "rev-parse",
        "--verify",
        "--quiet",
        "ORIG_HEAD"
    ]));
}

#[test]
fn gh_is_run_with_the_one_create_shape() {
    let bin = fake("gh", "for arg in \"$@\"; do echo \"$arg\"; done");
    let vault = tempfile::tempdir().unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    let output = host.create_repo(vault.path(), "my-vault").unwrap();
    assert_eq!(
        output.stdout.lines().collect::<Vec<_>>(),
        [
            "repo",
            "create",
            "my-vault",
            "--private",
            "--source=.",
            "--remote=origin",
            "--push"
        ]
    );
}

#[test]
fn the_mac_has_a_name() {
    assert!(!super::mac_name().trim().is_empty());
}

// --- A real git round trip ------------------------------------------------

/// The system git's folder, when there is one.
fn real_git_dir() -> Option<PathBuf> {
    GIT_DIRS
        .iter()
        .map(PathBuf::from)
        .find(|dir| dir.join("git").is_file())
}

fn ok(output: GitOutput) -> GitOutput {
    assert_eq!(output.code, Some(0), "{output:?}");
    output
}

/// Runs a checkout as the sync does: saying what it saw of the file, just now.
fn checkout_as_it_is(host: &GitHost, root: &Path, list: &[&str]) -> Result<GitOutput, String> {
    let path = list.last().copied().unwrap_or_default();
    let seen = Seen {
        blob: host.blob_of(root, path).unwrap(),
    };
    host.git_in_vault_seen(root, &args(list), Some(&seen))
}

fn commit(host: &GitHost, repo: &Path, message: &str) {
    ok(host.git_in_vault(repo, &args(&["add", "--all"])).unwrap());
    ok(host
        .git_in_vault(
            repo,
            &args(&[
                "-c",
                "user.name=DFAI Test",
                "-c",
                "user.email=atlas@test.local",
                "commit",
                "--quiet",
                "--no-verify",
                "-m",
                message,
            ]),
        )
        .unwrap());
}

fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().is_some_and(|name| name == ".git") {
            continue;
        }
        if path.is_dir() {
            found.extend(files_under(&path));
        } else {
            found.push(path);
        }
    }
    found
}

/// #630 attack: the settings on GitHub are read only for the branch checked
/// out; another branch of origin is refused before git runs.
#[test]
fn the_settings_on_github_are_read_for_the_branch_checked_out_only() {
    let Some(git_dir) = real_git_dir() else {
        println!("skipped: no git in {GIT_DIRS:?}");
        return;
    };
    let work = tempfile::tempdir().unwrap();
    let home = work.path().join("home");
    fs::create_dir(&home).unwrap();
    let host = host_in(&[&git_dir], Some(home), NO_LIMIT);
    let a = work.path().join("A");
    let bare = work.path().join("remote.git");
    fs::create_dir(&a).unwrap();
    let made = Command::new(git_dir.join("git"))
        .args(["init", "--quiet", "--bare", "--initial-branch=main"])
        .arg(&bare)
        .status()
        .unwrap();
    assert!(made.success());
    ok(host
        .git_in_vault(&a, &args(&["init", "--quiet", "--initial-branch=main"]))
        .unwrap());
    fs::create_dir(a.join(".atlas")).unwrap();
    let settings = "---\nautomationsMac: mac-studio\nautomationsMacName: Studio\n---\n";
    fs::write(a.join(".atlas/settings.md"), settings).unwrap();
    commit(&host, &a, "DFAI sync set up");
    let remote = bare.display().to_string();
    ok(host
        .git_in_vault(&a, &args(&["remote", "add", "origin", &remote]))
        .unwrap());
    ok(host
        .git_in_vault(
            &a,
            &args(&["push", "--quiet", "--set-upstream", "origin", "HEAD"]),
        )
        .unwrap());
    // The claim here, not pushed: what GitHub holds is still Studio's.
    fs::write(
        a.join(".atlas/settings.md"),
        "---\nautomationsMac: mac-laptop\n---\n",
    )
    .unwrap();

    let read = ok(host
        .git_in_vault(
            &a,
            &args(&["cat-file", "blob", "origin/main:.atlas/settings.md"]),
        )
        .unwrap());
    assert_eq!(read.stdout, settings);

    // Another branch of origin, there on GitHub, is not the one checked out.
    ok(host
        .git_in_vault(&a, &args(&["branch", "-m", "elsewhere"]))
        .unwrap());
    let refused = host
        .git_in_vault(
            &a,
            &args(&["cat-file", "blob", "origin/main:.atlas/settings.md"]),
        )
        .unwrap_err();
    assert!(refused.contains("not the branch checked out"), "{refused}");
}

/// Two Macs change one note differently and another note on one side; the
/// merge conflicts, and the conflict is resolved with the host's own shapes:
/// this Mac's version in place, the other's saved beside it, no markers.
#[test]
fn a_conflict_round_trip_keeps_both_versions_and_leaves_no_markers() {
    let Some(git_dir) = real_git_dir() else {
        println!("skipped: no git in {GIT_DIRS:?}");
        return;
    };
    let work = tempfile::tempdir().unwrap();
    // A home of its own, so the person's global git config plays no part.
    let home = work.path().join("home");
    fs::create_dir(&home).unwrap();
    let host = host_in(&[&git_dir], Some(home), NO_LIMIT);
    let a = work.path().join("A");
    let macs = work.path().join("macs");
    let bare = work.path().join("remote.git");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&macs).unwrap();
    let made = Command::new(git_dir.join("git"))
        .args(["init", "--quiet", "--bare", "--initial-branch=main"])
        .arg(&bare)
        .status()
        .unwrap();
    assert!(made.success());

    // Mac A sets up sync.
    ok(host
        .git_in_vault(&a, &args(&["init", "--quiet", "--initial-branch=main"]))
        .unwrap());
    fs::write(a.join("Note.md"), "# Note\n\nbase\n").unwrap();
    fs::write(a.join("Other.md"), "other\n").unwrap();
    commit(&host, &a, "DFAI sync set up");
    let remote = bare.display().to_string();
    ok(host
        .git_in_vault(&a, &args(&["remote", "add", "origin", &remote]))
        .unwrap());
    ok(host
        .git_in_vault(
            &a,
            &args(&["push", "--quiet", "--set-upstream", "origin", "HEAD"]),
        )
        .unwrap());

    // Mac B opens it from the remote, into a folder the person picked.
    host.grant(&macs).unwrap();
    ok(host
        .git_in_folder(
            &macs,
            &args(&["clone", "--quiet", "--origin", "origin", "--", &remote, "B"]),
            None,
        )
        .unwrap());
    let b = macs.join("B");
    let from_b = "# Note\n\nwritten on B\r\n\u{2014} with bytes \u{e9}\n";
    fs::write(b.join("Note.md"), from_b).unwrap();
    fs::write(b.join("Other.md"), "other, from B\n").unwrap();
    commit(&host, &b, "DFAI sync from B");
    ok(host
        .git_in_vault(
            &b,
            &args(&["push", "--quiet", "--set-upstream", "origin", "HEAD"]),
        )
        .unwrap());

    // Mac A changed the same note meanwhile, then syncs.
    let from_a = "# Note\n\nwritten on A\n";
    fs::write(a.join("Note.md"), from_a).unwrap();
    commit(&host, &a, "DFAI sync from A");
    ok(host
        .git_in_vault(&a, &args(&["fetch", "--quiet", "origin"]))
        .unwrap());
    let merged = host
        .git_in_vault(
            &a,
            &args(&[
                "merge",
                "--no-edit",
                "--allow-unrelated-histories",
                "origin/main",
            ]),
        )
        .unwrap();
    assert_ne!(merged.code, Some(0), "the edits conflict: {merged:?}");
    let status = ok(host
        .git_in_vault(
            &a,
            &args(&[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ]),
        )
        .unwrap());
    assert!(
        status
            .stdout
            .split('\0')
            .any(|entry| entry.starts_with("u UU ") && entry.ends_with(" Note.md")),
        "{:?}",
        status.stdout
    );

    // Resolve: theirs beside, ours in place, as the TypeScript side does.
    let copy = "Note (conflict from B).md";
    ok(checkout_as_it_is(&host, &a, &["checkout", "--theirs", "--", "Note.md"]).unwrap());
    fs::rename(a.join("Note.md"), a.join(copy)).unwrap();
    ok(checkout_as_it_is(&host, &a, &["checkout", "--ours", "--", "Note.md"]).unwrap());
    commit(&host, &a, "DFAI sync from A, keeping both");
    ok(host
        .git_in_vault(
            &a,
            &args(&["push", "--quiet", "--set-upstream", "origin", "HEAD"]),
        )
        .unwrap());

    assert_eq!(fs::read(a.join("Note.md")).unwrap(), from_a.as_bytes());
    assert_eq!(fs::read(a.join(copy)).unwrap(), from_b.as_bytes());
    assert_eq!(
        fs::read_to_string(a.join("Other.md")).unwrap(),
        "other, from B\n"
    );
    for file in files_under(&a) {
        let text = String::from_utf8_lossy(&fs::read(&file).unwrap()).into_owned();
        assert!(
            !text.contains("<<<<<<<") && !text.contains(">>>>>>>"),
            "{} holds conflict markers",
            file.display()
        );
    }
    let clean = ok(host
        .git_in_vault(
            &a,
            &args(&[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ]),
        )
        .unwrap());
    assert!(
        !clean
            .stdout
            .split('\0')
            .any(|entry| !entry.is_empty() && !entry.starts_with('#')),
        "{:?}",
        clean.stdout
    );

    // Mac B pulls the resolution: both versions arrive, still byte for byte.
    ok(host
        .git_in_vault(&b, &args(&["fetch", "--quiet", "origin"]))
        .unwrap());
    ok(host
        .git_in_vault(
            &b,
            &args(&[
                "merge",
                "--no-edit",
                "--allow-unrelated-histories",
                "origin/main",
            ]),
        )
        .unwrap());
    assert_eq!(fs::read(b.join("Note.md")).unwrap(), from_a.as_bytes());
    assert_eq!(fs::read(b.join(copy)).unwrap(), from_b.as_bytes());
}

/// A hook planted in the vault's `.git` never runs: the prefix points git's
/// hooks at nothing.
#[test]
fn a_hook_in_the_vault_never_runs() {
    let Some(git_dir) = real_git_dir() else {
        println!("skipped: no git in {GIT_DIRS:?}");
        return;
    };
    let work = tempfile::tempdir().unwrap();
    let home = work.path().join("home");
    fs::create_dir(&home).unwrap();
    let host = host_in(&[&git_dir], Some(home), NO_LIMIT);
    let vault = work.path().join("vault");
    fs::create_dir(&vault).unwrap();
    ok(host
        .git_in_vault(&vault, &args(&["init", "--quiet", "--initial-branch=main"]))
        .unwrap());
    let ran = work.path().join("hook-ran");
    let hook = vault.join(".git/hooks/pre-commit");
    fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", ran.display())).unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    let post = vault.join(".git/hooks/post-commit");
    fs::copy(&hook, &post).unwrap();
    fs::write(vault.join("Note.md"), "x\n").unwrap();
    // `--no-verify` skips pre-commit; post-commit would still run without the prefix.
    commit(&host, &vault, "DFAI sync");
    assert!(!ran.exists(), "a hook ran");
}

// --- Adversarial (U-29 review) ----------------------------------------------

#[test]
fn adversarial_an_ssh_address_whose_host_starts_like_an_option_is_refused() {
    // CVE-2017-1000117's shape: the host slot of an ssh:// URL handed to ssh as
    // an option. Git itself refuses it today; the shape check says it refuses
    // anything that starts like an option, and this host does.
    let url = "ssh://-oProxyCommand=open${IFS}-a${IFS}Calculator/x";
    assert!(!is_url(url), "{url:?}");
    assert!(!vault_ok(&["remote", "add", "origin", url]));
}

#[test]
fn adversarial_odd_but_real_note_paths_reach_checkout() {
    let ours = |path: &str| vault_ok(&["checkout", "--ours", "--", path]);
    for accepted in [
        "My note -> draft.md",
        "Caf\u{e9}/na\u{ef}ve \u{65e5}\u{672c}.md",
        "two\nlines.md",
        "Ideas [draft] *?.md",
        ":(top)looks like magic.md",
        "..hidden dots.md",
        "Sync conflicts/atlas/settings (conflict from Work-Home Mac).md",
    ] {
        assert!(ours(accepted), "{accepted:?}");
    }
    for refused in [".Git", "a/.gIt/x", "a/../b", "a/./b", "a/"] {
        assert!(!ours(refused), "{refused:?}");
    }
}

#[test]
fn adversarial_a_clone_name_is_one_plain_new_folder() {
    let clone = |name: &str| {
        folder_ok(&[
            "clone", "--quiet", "--origin", "origin", "--", "/r.git", name,
        ])
    };
    assert!(clone("notes"));
    assert!(clone(&"n".repeat(255)));
    for refused in [
        "".to_string(),
        ".".to_string(),
        "..".to_string(),
        ".git".to_string(),
        "-x".to_string(),
        "a/b".to_string(),
        "a\0b".to_string(),
        "n".repeat(256),
    ] {
        assert!(!clone(&refused), "{refused:?}");
    }
}

#[test]
fn adversarial_a_merge_ref_never_escapes_origin() {
    let merge = |reference: &str| {
        vault_ok(&[
            "merge",
            "--no-edit",
            "--allow-unrelated-histories",
            reference,
        ])
    };
    assert!(merge("origin/main"));
    assert!(merge("origin/feature/x"));
    for refused in [
        "origin/",
        "origin/main..origin/x",
        "origin/-x",
        "origin/main@{1}",
        "origin/main^",
        "origin/main~1",
        "origin//main",
        "main",
        "upstream/main",
    ] {
        assert!(!merge(refused), "{refused:?}");
    }
}

/// `--literal-pathspecs` in the fixed prefix is what keeps a note named like
/// a glob from reaching other files: `checkout --ours -- "Idea [ab].md"` must
/// not also touch `Idea a.md`.
#[test]
fn adversarial_a_checkout_of_a_glob_like_name_touches_only_that_file() {
    let Some(git_dir) = real_git_dir() else {
        println!("skipped: no git in {GIT_DIRS:?}");
        return;
    };
    let work = tempfile::tempdir().unwrap();
    let home = work.path().join("home");
    fs::create_dir(&home).unwrap();
    let host = host_in(&[&git_dir], Some(home), NO_LIMIT);
    let repo = work.path().join("A");
    fs::create_dir(&repo).unwrap();
    ok(host
        .git_in_vault(&repo, &args(&["init", "--quiet", "--initial-branch=main"]))
        .unwrap());
    fs::write(repo.join("Idea [ab].md"), "committed glob\n").unwrap();
    fs::write(repo.join("Idea a.md"), "committed a\n").unwrap();
    commit(&host, &repo, "base");
    fs::write(repo.join("Idea [ab].md"), "edited glob\n").unwrap();
    fs::write(repo.join("Idea a.md"), "edited a\n").unwrap();
    ok(checkout_as_it_is(&host, &repo, &["checkout", "--ours", "--", "Idea [ab].md"]).unwrap());
    assert_eq!(
        fs::read_to_string(repo.join("Idea [ab].md")).unwrap(),
        "committed glob\n"
    );
    assert_eq!(
        fs::read_to_string(repo.join("Idea a.md")).unwrap(),
        "edited a\n",
        "a glob-like path reached another file"
    );
}

// --- A30: two Macs, one remote --------------------------------------------

/// A vault opened through a symlink (`~/Vault` -> `~/Documents/Vault`): the open
/// vault's root is kept as it was picked, so TypeScript asks about the folder
/// above the link (`parentFolderOf(vaultRoot)`), while the host allows only
/// the folder above the resolved vault. Every inspection then fails with "that
/// folder was not chosen in DFAI", and sync can never be set up, nor refused
/// for the right reason.
#[test]
fn adversarial_a_vault_opened_through_a_symlink_can_be_asked_where_it_sits() {
    let bin = fake("git", "echo asked");
    let work = tempfile::tempdir().unwrap();
    let real = work.path().join("Documents").join("Vault");
    fs::create_dir_all(&real).unwrap();
    let links = work.path().join("home");
    fs::create_dir(&links).unwrap();
    let link = links.join("Vault");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    // What `repositoryPlace` sends: the folder above the vault's root as it was opened.
    let asked = host.git_in_folder(
        link.parent().unwrap(),
        &args(&["rev-parse", "--show-toplevel"]),
        Some(&link),
    );
    assert_eq!(asked.map(|output| output.stdout), Ok("asked\n".to_string()));
}

/// Branch names git allows and people use (`notes+work`, `café`): the Ref slot
/// refuses them, so a vault on such a branch fails every sync at the first
/// `rev-parse --verify origin/<branch>`, with a message about arguments.
#[test]
fn adversarial_a_branch_git_allows_can_be_merged() {
    for branch in ["origin/notes+work", "origin/caf\u{e9}", "origin/james@home"] {
        assert!(
            vault_ok(&["rev-parse", "--verify", "--quiet", branch]),
            "{branch:?} is a branch git allows"
        );
    }
}

// --- A29-01: the review's host findings ------------------------------------

/// A Mac's own git settings would otherwise decide how a sync goes: a commit
/// that must be signed fails without the key, `merge.ff=only` refuses every
/// merge, `core.autocrlf` rewrites line endings, and a global excludes file
/// leaves attachments out. Every run in the vault turns each off.
#[test]
fn a_run_in_the_vault_turns_off_the_macs_own_git_settings() {
    let bin = fake("git", "for arg in \"$@\"; do echo \"$arg\"; done");
    let vault = tempfile::tempdir().unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    let output = host
        .git_in_vault(vault.path(), &args(&["add", "--all"]))
        .unwrap();
    let lines: Vec<&str> = output.stdout.lines().collect();
    let settings: Vec<&str> = lines
        .windows(2)
        .filter(|pair| pair[0] == "-c")
        .map(|pair| pair[1])
        .collect();
    for setting in [
        "commit.gpgSign=false",
        "tag.gpgSign=false",
        "merge.ff=true",
        "core.autocrlf=false",
    ] {
        assert!(settings.contains(&setting), "{setting} in {settings:?}");
    }
    let excludes = vault
        .path()
        .canonicalize()
        .unwrap()
        .join(".git/atlas-sync/exclude");
    assert!(
        settings.contains(&format!("core.excludesFile={}", excludes.display()).as_str()),
        "the vault's own excludes file in {settings:?}"
    );
}

/// `gh repo create --push` runs git itself: the vault's hooks must not run
/// there either, nor the Mac's signing setting.
#[test]
fn gh_runs_git_with_the_vaults_hooks_off() {
    let bin = fake("gh", "env | grep '^GIT_CONFIG_' | sort");
    let vault = tempfile::tempdir().unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    let output = host.create_repo(vault.path(), "my-vault").unwrap();
    let env: Vec<&str> = output.stdout.lines().collect();
    let value_of = |key: &str| {
        let slot = env
            .iter()
            .find(|line| line.starts_with("GIT_CONFIG_KEY_") && line.ends_with(&format!("={key}")))?
            .strip_prefix("GIT_CONFIG_KEY_")?
            .split('=')
            .next()?
            .to_string();
        env.iter()
            .find_map(|line| line.strip_prefix(&format!("GIT_CONFIG_VALUE_{slot}=")))
            .map(str::to_string)
    };
    assert_eq!(
        value_of("core.hooksPath").as_deref(),
        Some("/dev/null"),
        "{env:?}"
    );
    assert_eq!(
        value_of("commit.gpgSign").as_deref(),
        Some("false"),
        "{env:?}"
    );
}

/// A push or fetch that is stopped never held the index lock; a lock there is
/// another run's — git in Terminal, say — and is left alone.
#[test]
fn a_stopped_network_run_leaves_the_index_lock_alone() {
    let bin = fake(
        "git",
        "mkdir -p .git && touch .git/index.lock && echo started\nexec sleep 30",
    );
    let vault = tempfile::tempdir().unwrap();
    let limits = Limits {
        local: Duration::from_secs(3600),
        network: Duration::from_secs(3),
    };
    let host = host_in(&[bin.path()], None, limits);
    let output = host
        .git_in_vault(vault.path(), &args(&["fetch", "--quiet", "origin"]))
        .unwrap();
    assert_eq!(output.code, None);
    assert!(vault.path().join(".git/index.lock").exists());
}

/// A lock older than the stopped run was not made by it, so it is not its to remove.
#[test]
fn a_stopped_local_run_leaves_an_older_lock_alone() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join(".git")).unwrap();
    let lock = vault.path().join(".git/index.lock");
    fs::write(&lock, "").unwrap();
    fs::File::options()
        .write(true)
        .open(&lock)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - Duration::from_secs(3600))
        .unwrap();
    let bin = fake("git", "exec sleep 30");
    let limits = Limits {
        local: Duration::from_secs(1),
        network: Duration::from_secs(3600),
    };
    let host = host_in(&[bin.path()], None, limits);
    let output = host
        .git_in_vault(vault.path(), &args(&["add", "--all"]))
        .unwrap();
    assert_eq!(output.code, None);
    assert!(lock.exists());
}

/// Git's own rules for a branch name (`git check-ref-format`), and never an option.
#[test]
fn a_branch_git_refuses_is_refused() {
    for branch in [
        "origin/a..b",
        "origin/-x",
        "origin/x.lock",
        "origin/a@{1}",
        "origin/a~1",
        "origin/a^",
        "origin/a:b",
        "origin/a b",
        "origin/.hidden",
        "origin/a/.b",
        "origin/a*",
        "origin/a?",
        "origin/a[b",
        "origin/a\\b",
        "origin/a/",
        "origin/a.",
        "origin/@",
        "origin/a//b",
        "origin/a\u{7f}",
    ] {
        assert!(
            !vault_ok(&["rev-parse", "--verify", "--quiet", branch]),
            "{branch:?} is not a branch git allows"
        );
    }
}

/// An address that carries a login or a token would put it in `.git/config`
/// and hand it back to the webview (ADR-0017); the host refuses it too.
#[test]
fn an_address_with_a_login_in_it_is_refused() {
    for url in [
        "https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/james/vault.git",
        "https://james:secret@github.com/james/vault.git",
        "ssh://git:hunter2@github.com/james/vault.git",
    ] {
        assert!(!is_url(url), "{url}");
    }
    assert!(is_url("ssh://git@github.com/james/vault.git"));
    assert!(is_url("git@github.com:james/vault.git"));
}

/// The sync files live in the vault's own `.git/atlas-sync/`, and only the
/// two TypeScript keeps there; a vault whose `.git` is not a folder of its own
/// has none.
#[test]
fn a_sync_file_round_trips_and_only_the_two_names_are_allowed() {
    let host = GitHost::default();
    let vault = tempfile::tempdir().unwrap();
    assert!(host.read_sync_file(vault.path(), "journal.json").is_err());
    fs::create_dir(vault.path().join(".git")).unwrap();
    assert_eq!(host.read_sync_file(vault.path(), "journal.json"), Ok(None));
    host.write_sync_file(vault.path(), "journal.json", Some("{\"v\":1}"))
        .unwrap();
    assert_eq!(
        host.read_sync_file(vault.path(), "journal.json"),
        Ok(Some("{\"v\":1}".to_string()))
    );
    assert!(vault.path().join(".git/atlas-sync/journal.json").is_file());
    host.write_sync_file(vault.path(), "journal.json", None)
        .unwrap();
    assert_eq!(host.read_sync_file(vault.path(), "journal.json"), Ok(None));
    // Removing what is not there is what was asked.
    host.write_sync_file(vault.path(), "exclude", None).unwrap();
    for name in ["config", "../config", "HEAD", "hooks/pre-commit", ""] {
        assert!(
            host.write_sync_file(vault.path(), name, Some("x")).is_err(),
            "{name}"
        );
        assert!(host.read_sync_file(vault.path(), name).is_err(), "{name}");
    }
    let huge = "x".repeat(super::MAX_SYNC_FILE + 1);
    assert!(host
        .write_sync_file(vault.path(), "exclude", Some(&huge))
        .is_err());
}

#[test]
fn a_vault_whose_git_is_a_link_has_no_sync_files() {
    let host = GitHost::default();
    let vault = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(elsewhere.path(), vault.path().join(".git")).unwrap();
    assert!(host
        .write_sync_file(vault.path(), "exclude", Some("x"))
        .is_err());
    assert!(!elsewhere.path().join("atlas-sync").exists());
}

/// Listing repositories is one fixed, read-only shape.
#[test]
fn gh_lists_repositories_with_the_one_read_only_shape() {
    let bin = fake("gh", "for arg in \"$@\"; do echo \"$arg\"; done");
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    let output = host.list_repos().unwrap();
    assert_eq!(
        output.stdout.lines().collect::<Vec<_>>(),
        [
            "repo",
            "list",
            "--json",
            "name,nameWithOwner,defaultBranchRef,visibility,url",
            "--limit",
            "1000"
        ]
    );
}

// --- A29-01: the second review ------------------------------------------------

/// A `status` that refreshes the index takes its lock, and then a sync's own
/// `add` or `merge` beside it fails; git's optional locks are off (review L5).
#[test]
fn a_run_in_the_vault_takes_no_optional_lock() {
    let bin = fake("git", "for arg in \"$@\"; do echo \"$arg\"; done");
    let vault = tempfile::tempdir().unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    let output = host
        .git_in_vault(
            vault.path(),
            &args(&[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ]),
        )
        .unwrap();
    assert!(
        output
            .stdout
            .lines()
            .any(|arg| arg == "--no-optional-locks"),
        "{}",
        output.stdout
    );
}

/// `.git/atlas-sync` that is a link would send the journal and the excludes
/// somewhere else, and read them back from there (review L9).
#[test]
fn a_sync_folder_that_is_a_link_is_refused() {
    let host = GitHost::default();
    let vault = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join(".git")).unwrap();
    std::os::unix::fs::symlink(elsewhere.path(), vault.path().join(".git/atlas-sync")).unwrap();
    fs::write(elsewhere.path().join("journal.json"), "from elsewhere").unwrap();
    assert!(host.read_sync_file(vault.path(), "journal.json").is_err());
    assert!(host
        .write_sync_file(vault.path(), "exclude", Some("x"))
        .is_err());
    assert!(!elsewhere.path().join("exclude").exists());
}

/// A sync file that is itself a link is not read through.
#[test]
fn a_sync_file_that_is_a_link_is_not_read_through() {
    let host = GitHost::default();
    let vault = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    fs::create_dir_all(vault.path().join(".git/atlas-sync")).unwrap();
    let secret = elsewhere.path().join("secret");
    fs::write(&secret, "not the vault's").unwrap();
    std::os::unix::fs::symlink(&secret, vault.path().join(".git/atlas-sync/journal.json")).unwrap();
    assert!(host.read_sync_file(vault.path(), "journal.json").is_err());
}

// Issue #8: an empty repository is refused before anything is cloned, by
// asking the remote which branches it has.
#[test]
fn asking_a_remote_for_its_branches_runs_outside_the_vault_and_nothing_else_does() {
    let branches = |url: &str| folder_ok(&["ls-remote", "--heads", "--", url]);
    assert!(branches("git@github.com:james/vault.git"));
    assert!(branches("https://github.com/james/vault.git"));
    assert!(!branches("ext::sh -c x"));
    assert!(!branches("--upload-pack=sh"));
    assert!(!folder_ok(&["ls-remote", "--heads", "/r.git"]));
    assert!(!folder_ok(&[
        "ls-remote",
        "--upload-pack=sh",
        "--heads",
        "--",
        "/r.git"
    ]));
}

// Issue #8: the open vault reached through a link — or through /var, which
// macOS spells /private/var — was not refused as the folder for a clone.
// The host resolves the two folders it is handed; TypeScript compares them.
#[test]
fn the_host_spells_the_open_vault_and_a_picked_folder_as_the_disk_does() {
    let parent = tempfile::tempdir().unwrap();
    let real = parent.path().join("DFAI Vault");
    fs::create_dir(&real).unwrap();
    let link = parent.path().join("Notes");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let canonical = real.canonicalize().unwrap();
    let host = GitHost::default();

    assert_eq!(host.on_disk(&link, Some(&link)).unwrap(), canonical);
    assert_eq!(host.on_disk(&real, None).unwrap_err(), NOT_CHOSEN);
    host.grant(&link).unwrap();
    assert_eq!(host.on_disk(&link, None).unwrap(), canonical);
    // Never a folder it was not handed: not even whether one exists.
    let elsewhere = tempfile::tempdir().unwrap();
    assert_eq!(
        host.on_disk(elsewhere.path(), Some(&link)).unwrap_err(),
        NOT_CHOSEN
    );
    assert_eq!(
        host.on_disk(&parent.path().join("nothing"), Some(&link))
            .unwrap_err(),
        NOT_CHOSEN
    );
}

#[cfg(target_os = "macos")]
#[test]
fn a_vault_under_var_is_spelled_under_private_var() {
    let dir = tempfile::tempdir_in("/var/tmp").unwrap();
    let host = GitHost::default();
    let resolved = host.on_disk(dir.path(), Some(dir.path())).unwrap();
    assert!(
        resolved.starts_with("/private/var/tmp"),
        "{}",
        resolved.display()
    );
}

/// #630 attack: the settings note on GitHub, as the last fetch left it, is
/// the one path read by `<rev>:<path>`: only `origin/<branch>`, only
/// `.atlas/settings.md`, spelled exactly.
#[test]
fn reading_the_settings_on_github_takes_only_origin_and_the_settings_note() {
    for refused in [
        "origin/main:Inbox/a.md",
        "origin/main:.atlas/settings.md.bak",
        "origin/main:./.atlas/settings.md",
        "origin/main:.atlas//settings.md",
        "origin/main:.ATLAS/settings.md",
        "origin/main:.atlas/settings.md\n",
        "origin/main:",
        "origin/main",
        "HEAD:.atlas/settings.md",
        "main:.atlas/settings.md",
        "origin/main^:.atlas/settings.md",
        "origin/main~1:.atlas/settings.md",
        "origin/a..b:.atlas/settings.md",
        "origin/-x:.atlas/settings.md",
        "origin/@{1}:.atlas/settings.md",
        "origin/:.atlas/settings.md",
        "upstream/main:.atlas/settings.md",
        ":.atlas/settings.md",
        "-origin/main:.atlas/settings.md",
    ] {
        assert!(!vault_ok(&["cat-file", "blob", refused]), "{refused:?}");
    }
    assert!(!vault_ok(&[
        "cat-file",
        "-p",
        "origin/main:.atlas/settings.md"
    ]));
    assert!(!folder_ok(&[
        "cat-file",
        "blob",
        "origin/main:.atlas/settings.md"
    ]));
}

/// #233 attack: `cat-file blob` is handed nothing git would read as an
/// option, a ref expression, a path or an abbreviated id.
#[test]
fn reading_a_blob_refuses_anything_but_a_full_lowercase_object_id() {
    let full = "0123456789abcdef0123456789abcdef01234567";
    let too_long = format!("{full}0");
    let with_peel = format!("{full}^{{tree}}");
    let with_path = format!("{full}:Notes/Idea.md");
    let dashed = format!("-{}", &full[1..]);
    let spaced = format!(" {}", &full[1..]);
    let newline = format!("{}\n", &full[..39]);
    for refused in [
        dashed.as_str(),
        "--batch-all-objects",
        "-e",
        "HEAD:.atlas/types/meeting.md",
        ":0:.atlas/types/meeting.md",
        ".atlas/types/meeting.md",
        "-x.md",
        "0123456",
        &full[..39],
        too_long.as_str(),
        with_peel.as_str(),
        with_path.as_str(),
        spaced.as_str(),
        newline.as_str(),
        "",
    ] {
        assert!(!vault_ok(&["cat-file", "blob", refused]), "{refused:?}");
    }
    assert!(!vault_ok(&["cat-file", "blob", "--", full]));
    assert!(!vault_ok(&["cat-file", "blob", full, full]));
    assert!(!vault_ok(&["cat-file", "tree", full]));
    assert!(!vault_ok(&["cat-file", "commit", full]));
    assert!(vault_ok(&["cat-file", "blob", full]));
    let sha256 = "0123456789abcdef".repeat(4);
    assert!(vault_ok(&["cat-file", "blob", &sha256]));
}

// --- #246: git's working-tree writes take the vault's change turn ----------

/// A named pipe: opening one end waits for the other, so a test can hold a
/// fake `git` mid-run and know it is there, with no sleep.
fn fifo(at: &Path) -> PathBuf {
    let status = Command::new("/usr/bin/mkfifo").arg(at).status().unwrap();
    assert!(status.success(), "mkfifo {}", at.display());
    at.to_path_buf()
}

/// A fake `git` that says it started, waits to be let go, then writes a note
/// in the vault, as a merge rewrites a pulled note.
struct HeldGit {
    bin: tempfile::TempDir,
    // Kept for as long as the fake runs: the pipes live here.
    _pipes: tempfile::TempDir,
    started: PathBuf,
    release: PathBuf,
}

fn held_git() -> HeldGit {
    let pipes = tempfile::tempdir().unwrap();
    let started = fifo(&pipes.path().join("started"));
    let release = fifo(&pipes.path().join("release"));
    let script = format!(
        "printf started > '{}'\nread go < '{}'\nprintf merged > a.md",
        started.display(),
        release.display()
    );
    HeldGit {
        bin: fake("git", &script),
        _pipes: pipes,
        started,
        release,
    }
}

/// Waits until the held git says it started, failing (never hanging) when
/// the run ends first: the pipe is opened without waiting for its writer.
fn wait_started<T>(held: &HeldGit, run: &std::thread::JoinHandle<T>) {
    use std::io::{ErrorKind, Read};
    use std::os::unix::fs::OpenOptionsExt;
    let mut pipe = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&held.started)
        .unwrap();
    let mut said = Vec::new();
    while said != b"started" {
        // Looked at before the read, so what a run wrote before ending is read first.
        let ended = run.is_finished();
        let mut chunk = [0u8; 16];
        match pipe.read(&mut chunk) {
            Ok(0) => assert!(!ended, "the fake git ended before it started"),
            Ok(read) => said.extend_from_slice(&chunk[..read]),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => panic!("the started pipe failed: {error}"),
        }
        std::thread::yield_now();
    }
}

/// Lets the held git go on, failing (never hanging) when it ended first:
/// opening a pipe to write without waiting fails until its reader is there.
fn release<T>(held: &HeldGit, run: &std::thread::JoinHandle<T>) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    loop {
        let ended = run.is_finished();
        match fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&held.release)
        {
            Ok(mut pipe) => return pipe.write_all(b"go\n").unwrap(),
            Err(error) if error.raw_os_error() == Some(libc::ENXIO) => {
                assert!(!ended, "the fake git ended before it was let go");
            }
            Err(error) => panic!("the release pipe failed: {error}"),
        }
        std::thread::yield_now();
    }
}

/// Yields until the thread waits for its turn (or a whole note), or has ended.
fn until_waiting_or_ended<T>(run: &std::thread::JoinHandle<T>) {
    let id = run.thread().id();
    while !crate::vault::turn_watch::is_waiting(id) && !run.is_finished() {
        std::thread::yield_now();
    }
}

#[test]
fn a_save_waits_while_a_merge_is_writing_the_vault() {
    let held = held_git();
    let vault = tempfile::tempdir().unwrap();
    fs::write(vault.path().join("a.md"), "before").unwrap();
    let host = host_in(&[held.bin.path()], None, NO_LIMIT);
    let root = vault.path().to_path_buf();
    let merge = std::thread::spawn(move || host.git_in_vault(&root, &args(MERGE)));
    wait_started(&held, &merge);
    // Who holds the turn, not only whether anyone does: another test's change
    // beside this one cannot pass for the merge's.
    let merge_held_the_turn = crate::vault::turn_watch::owner() == Some(merge.thread().id());
    let root = vault.path().to_path_buf();
    let save = std::thread::spawn(move || {
        crate::vault::test_access::write_text(&root, "a.md", "saved", crate::vault::BasedOn::ANY)
    });
    until_waiting_or_ended(&save);
    let save_waited = !save.is_finished();
    // Let the merge finish before asserting, so a failure leaves no fake git waiting.
    release(&held, &merge);
    assert_eq!(merge.join().unwrap().unwrap().code, Some(0));
    save.join().unwrap().unwrap();
    assert!(
        merge_held_the_turn,
        "a merge ran outside the vault's change turn"
    );
    assert!(save_waited, "a save landed while the merge was writing");
    assert_eq!(
        fs::read_to_string(vault.path().join("a.md")).unwrap(),
        "saved",
        "the save landed under the merge"
    );
}

#[test]
fn a_git_write_inside_a_change_turn_runs_rather_than_waiting_on_itself() {
    let bin = fake("git", "printf merged > a.md");
    let vault = tempfile::tempdir().unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    let merge = args(&[
        "merge",
        "--no-edit",
        "--allow-unrelated-histories",
        "origin/main",
    ]);
    let output = crate::vault::one_change_at_a_time(|| host.git_in_vault(vault.path(), &merge));
    assert_eq!(output.unwrap().code, Some(0));
    assert_eq!(
        fs::read_to_string(vault.path().join("a.md")).unwrap(),
        "merged"
    );
}

#[test]
fn only_the_commands_that_rewrite_notes_take_the_change_turn() {
    for shape in ACCEPTED {
        let verb = shape
            .iter()
            .copied()
            .find(|arg| *arg != "-c" && !arg.contains('='))
            .unwrap_or_default();
        let writes = matches!(verb, "merge" | "checkout" | "checkout-index" | "mv");
        assert_eq!(writes_working_tree(&args(shape)), writes, "{shape:?}");
    }
    for network in [
        &["fetch", "--quiet", "origin"][..],
        &["push", "--quiet", "--set-upstream", "origin", "HEAD"],
        &["ls-remote", "--symref", "origin", "HEAD"],
    ] {
        assert_eq!(vet_vault_args(&args(network)), Ok(Reach::Network));
        assert!(!writes_working_tree(&args(network)), "{network:?}");
    }
    assert!(!writes_working_tree(&[]));
}

#[test]
fn a_command_after_leading_settings_is_known_by_its_own_verb() {
    let set = |list: &[&str]| args(list);
    assert!(writes_working_tree(&set(&["-c", "a=b", "merge", "x"])));
    assert!(writes_working_tree(&set(&[
        "-c", "a=b", "-c", "c=d", "mv", "--", "a", "b"
    ])));
    // A setting's value that spells a writing verb is not the command.
    assert!(!writes_working_tree(&set(&["-c", "merge", "commit"])));
    assert!(!writes_working_tree(&set(&[
        "-c",
        "user.name=merge",
        "commit"
    ])));
    assert!(!writes_working_tree(&set(&["-c"])));
    assert_eq!(
        overwritten_path(&set(&["checkout", "--theirs", "--", "Note.md"])),
        Some("Note.md")
    );
    assert_eq!(
        overwritten_path(&set(&["checkout-index", "--", "Note.md"])),
        None
    );
    assert_eq!(overwritten_path(&set(&["merge", "origin/main"])), None);
}

#[test]
fn a_checkout_must_say_what_it_saw_and_nothing_else_may() {
    let bin = fake("git", "printf ran > ran");
    let vault = tempfile::tempdir().unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    let checkout = args(&["checkout", "--ours", "--", "Note.md"]);
    assert!(host.git_in_vault(vault.path(), &checkout).is_err());
    let seen = Seen { blob: None };
    assert!(host
        .git_in_vault_seen(vault.path(), &args(MERGE), Some(&seen))
        .is_err());
    assert!(!vault.path().join("ran").exists(), "git ran regardless");
}

#[test]
fn a_checkout_runs_over_the_file_it_saw_and_not_over_one_made_since() {
    let Some(git_dir) = real_git_dir() else {
        println!("skipped: no git in {GIT_DIRS:?}");
        return;
    };
    let home = tempfile::tempdir().unwrap();
    let host = host_in(&[&git_dir], Some(home.path().to_path_buf()), NO_LIMIT);
    let vault = conflicted_vault(&git_dir, &host);
    let root = vault.path();
    let theirs = args(&["checkout", "--theirs", "--", "Note.md"]);

    // Saw no file, but the person has made one there since: it is kept.
    let absent = Seen { blob: None };
    let refused = host.git_in_vault_seen(root, &theirs, Some(&absent));
    assert!(
        matches!(&refused, Err(why) if why.starts_with(CHANGED)),
        "{refused:?}"
    );
    assert!(fs::read_to_string(root.join("Note.md"))
        .unwrap()
        .contains("<<<<<<<"));

    // Saw the file as it still is: the other Mac's side is written over it.
    ok(checkout_as_it_is(&host, root, &["checkout", "--theirs", "--", "Note.md"]).unwrap());
    assert_eq!(
        fs::read_to_string(root.join("Note.md")).unwrap(),
        "theirs\n"
    );

    // Saw no file, and there is none: it is written.
    fs::remove_file(root.join("Note.md")).unwrap();
    ok(host
        .git_in_vault_seen(root, &theirs, Some(&absent))
        .unwrap());
    assert_eq!(
        fs::read_to_string(root.join("Note.md")).unwrap(),
        "theirs\n"
    );
}

#[test]
fn a_git_write_in_a_vault_no_longer_open_is_refused_and_one_in_the_open_vault_runs() {
    let bin = fake("git", "printf merged > a.md");
    let vault = tempfile::tempdir().unwrap();
    let state = crate::vault::VaultState::default();
    let location = crate::vault::location_of(vault.path());
    crate::vault::switch_vault(&state, &location, |_| Ok(())).unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);
    let run = |meant_for: &str| {
        host.git_in_open_vault(VaultRun {
            state: &state,
            meant_for,
            args: &args(MERGE),
            seen: None,
        })
    };
    assert!(run("/somewhere/else").is_err());
    assert!(!vault.path().join("a.md").exists());
    let open = state.get().unwrap().display().to_string();
    assert_eq!(run(&open).unwrap().code, Some(0));
    assert_eq!(
        fs::read_to_string(vault.path().join("a.md")).unwrap(),
        "merged"
    );
}

/// A save lands by rename, so reads never wait behind one: only git's own
/// writes make a read wait.
#[test]
fn a_read_does_not_wait_behind_a_save_holding_the_turn() {
    let vault = tempfile::tempdir().unwrap();
    fs::write(vault.path().join("a.md"), "before").unwrap();
    let (held, hold) = std::sync::mpsc::channel::<()>();
    let (taken, turn_taken) = std::sync::mpsc::channel();
    let saver = std::thread::spawn(move || {
        crate::vault::one_change_at_a_time(|| {
            taken.send(()).unwrap();
            // Holds the turn until the test drops its end: the error that
            // recv then answers is the signal, not a failure.
            let _ = hold.recv();
        })
    });
    turn_taken.recv().unwrap();
    let root = vault.path().to_path_buf();
    let read = within_a_minute(move || crate::vault::test_access::read_text(&root, "a.md"));
    drop(held);
    saver.join().unwrap();
    assert_eq!(read.unwrap().text, "before");
}

// --- #246 attack: where the change turn does not reach -----------------------

const MERGE: &[&str] = &[
    "merge",
    "--no-edit",
    "--allow-unrelated-histories",
    "origin/main",
];

/// Runs the system git directly, for setting a repository up; the host's
/// shapes do not cover making branches.
fn raw_git(git_dir: &Path, repo: &Path, list: &[&str]) {
    let status = Command::new(git_dir.join("git"))
        .args([
            "-c",
            "user.name=DFAI Test",
            "-c",
            "user.email=atlas@test.local",
        ])
        .args(list)
        .current_dir(repo)
        .env("HOME", repo)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .status()
        .unwrap();
    assert!(status.success(), "git {list:?}");
}

/// A vault whose merge of `origin/main` leaves `Note.md` in conflict: this
/// Mac wrote "ours", the other wrote "theirs".
fn conflicted_vault(git_dir: &Path, host: &GitHost) -> tempfile::TempDir {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    raw_git(git_dir, root, &["init", "--quiet", "--initial-branch=main"]);
    fs::write(root.join("Note.md"), "base\n").unwrap();
    raw_git(git_dir, root, &["add", "--all"]);
    raw_git(git_dir, root, &["commit", "--quiet", "-m", "base"]);
    raw_git(git_dir, root, &["branch", "other"]);
    fs::write(root.join("Note.md"), "ours\n").unwrap();
    raw_git(git_dir, root, &["commit", "--quiet", "-am", "ours"]);
    raw_git(git_dir, root, &["checkout", "--quiet", "other"]);
    fs::write(root.join("Note.md"), "theirs\n").unwrap();
    raw_git(git_dir, root, &["commit", "--quiet", "-am", "theirs"]);
    raw_git(git_dir, root, &["checkout", "--quiet", "main"]);
    raw_git(
        git_dir,
        root,
        &["update-ref", "refs/remotes/origin/main", "other"],
    );
    let merged = host.git_in_vault(root, &args(MERGE)).unwrap();
    assert_ne!(
        merged.code,
        Some(0),
        "the merge should conflict: {merged:?}"
    );
    vault
}

/// Settling a conflict reads the note's blob (`hash-object`, no turn), then
/// decides to keep this Mac's side and runs `checkout --ours`. A save that
/// lands between the two is overwritten: the turn covers each command, not
/// the read-decide-write the sync makes across them (settle-conflicts.ts).
#[test]
fn a_save_between_the_syncs_look_at_a_conflict_and_its_checkout_is_kept() {
    let Some(git_dir) = real_git_dir() else {
        println!("skipped: no git in {GIT_DIRS:?}");
        return;
    };
    let home = tempfile::tempdir().unwrap();
    let host = host_in(&[&git_dir], Some(home.path().to_path_buf()), NO_LIMIT);
    let vault = conflicted_vault(&git_dir, &host);
    let root = vault.path();

    // The sync looks at the file and sees the merge's own result.
    let looked = ok(host
        .git_in_vault(
            root,
            &args(&["hash-object", "--no-filters", "--", "Note.md"]),
        )
        .unwrap());
    let seen = Seen {
        blob: Some(looked.stdout.trim().to_string()),
    };
    // The person saves the note they have open.
    crate::vault::one_change_at_a_time(|| {
        crate::vault::test_access::write_text(
            root,
            "Note.md",
            "typed while syncing\n",
            crate::vault::BasedOn::ANY,
        )
    })
    .unwrap();
    // The sync acts on what it saw, and is told the file changed since.
    let refused = host.git_in_vault_seen(
        root,
        &args(&["checkout", "--ours", "--", "Note.md"]),
        Some(&seen),
    );
    assert!(
        matches!(&refused, Err(why) if why.starts_with(CHANGED)),
        "{refused:?}"
    );

    assert_eq!(
        fs::read_to_string(root.join("Note.md")).unwrap(),
        "typed while syncing\n",
        "checkout --ours overwrote a save made after the sync looked at the note"
    );
}

/// `git_run` used to check the vault it was meant for before the git write
/// waited for its turn, unlike `change_in_vault`, which checks inside the
/// turn. A switch that landed while the merge waited was followed by the
/// merge writing the old vault, breaking `switch_vault`'s "once it answers
/// nothing more lands in the old vault". `git_in_open_vault` is what the
/// command runs, as the command itself needs a running app.
#[test]
fn a_git_write_queued_before_a_vault_switch_does_not_land_in_the_old_vault() {
    let bin = fake("git", "printf merged > a.md");
    let old = tempfile::tempdir().unwrap();
    let new = tempfile::tempdir().unwrap();
    fs::write(old.path().join("a.md"), "before").unwrap();
    let state = crate::vault::VaultState::default();
    let at = |dir: &Path| crate::vault::location_of(dir);
    crate::vault::switch_vault(&state, &at(old.path()), |_| Ok(())).unwrap();
    let host = host_in(&[bin.path()], None, NO_LIMIT);

    // git_run is asked for a merge in the vault that was open.
    let meant_for = old.path().display().to_string();
    // The person opens another vault before the merge's turn comes.
    crate::vault::switch_vault(&state, &at(new.path()), |_| Ok(())).unwrap();
    let ran = host.git_in_open_vault(VaultRun {
        state: &state,
        meant_for: &meant_for,
        args: &args(MERGE),
        seen: None,
    });
    assert!(ran.is_err(), "{ran:?}");

    assert_eq!(
        fs::read_to_string(old.path().join("a.md")).unwrap(),
        "before",
        "a merge wrote the old vault after the switch answered: {ran:?}"
    );
}

/// A fake `git` that deletes the note, waits to be let go, then writes it
/// anew, as git's checkout does (it unlinks a file and creates it again).
fn rewriting_git() -> HeldGit {
    let pipes = tempfile::tempdir().unwrap();
    let started = fifo(&pipes.path().join("started"));
    let release = fifo(&pipes.path().join("release"));
    let script = format!(
        "rm a.md\nprintf started > '{}'\nread go < '{}'\nprintf merged > a.md",
        started.display(),
        release.display()
    );
    HeldGit {
        bin: fake("git", &script),
        _pipes: pipes,
        started,
        release,
    }
}

/// Reads take no turn because a save lands by rename, so a read sees the old
/// note or the new one whole. A git write is not a rename: a read while a
/// merge is under way finds the note gone (or part-written).
#[test]
fn a_read_during_a_merge_sees_the_note_whole() {
    let held = rewriting_git();
    let vault = tempfile::tempdir().unwrap();
    fs::write(vault.path().join("a.md"), "before").unwrap();
    let host = host_in(&[held.bin.path()], None, NO_LIMIT);
    let root = vault.path().to_path_buf();
    let merge = std::thread::spawn(move || host.git_in_vault(&root, &args(MERGE)));
    wait_started(&held, &merge);
    // The vault's own read, as the commands make it, from a thread of its own:
    // it either reads at once or waits for the merge, and the test sees which.
    let root = vault.path().to_path_buf();
    let read = std::thread::spawn(move || {
        crate::vault::test_access::read_text(&root, "a.md").map(|note| note.text)
    });
    until_waiting_or_ended(&read);
    release(&held, &merge);
    assert_eq!(merge.join().unwrap().unwrap().code, Some(0));
    let seen = read.join().unwrap();
    assert!(
        matches!(seen.as_deref(), Ok("before") | Ok("merged")),
        "a read during a merge saw {seen:?}"
    );
}

/// Waits for `work` on a thread of its own, failing rather than hanging when
/// the change turn was never given back.
fn within_a_minute<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    let (done, answer) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = done.send(work());
    });
    answer
        .recv_timeout(Duration::from_secs(60))
        .expect("the change turn was not given back")
}

#[test]
fn a_merge_that_is_stopped_for_running_too_long_gives_the_turn_back() {
    let pipes = tempfile::tempdir().unwrap();
    let never = fifo(&pipes.path().join("never"));
    let bin = fake("git", &format!("read go < '{}'", never.display()));
    let vault = tempfile::tempdir().unwrap();
    fs::write(vault.path().join("a.md"), "before").unwrap();
    let limits = Limits {
        local: Duration::from_millis(200),
        network: Duration::from_millis(200),
    };
    let host = host_in(&[bin.path()], None, limits);
    let stopped = host.git_in_vault(vault.path(), &args(MERGE)).unwrap();
    assert_eq!(stopped.code, None, "{stopped:?}");
    let root = vault.path().to_path_buf();
    within_a_minute(move || {
        crate::vault::test_access::write_text(&root, "a.md", "saved", crate::vault::BasedOn::ANY)
    })
    .unwrap();
    assert_eq!(
        fs::read_to_string(vault.path().join("a.md")).unwrap(),
        "saved"
    );
}

#[test]
fn a_merge_that_fails_or_cannot_start_gives_the_turn_back() {
    let failing = fake("git", "printf half > a.md\nexit 1");
    let vault = tempfile::tempdir().unwrap();
    let host = host_in(&[failing.path()], None, NO_LIMIT);
    assert_eq!(
        host.git_in_vault(vault.path(), &args(MERGE)).unwrap().code,
        Some(1)
    );
    let missing = host_in(&[], None, NO_LIMIT);
    assert!(missing.git_in_vault(vault.path(), &args(MERGE)).is_err());
    let root = vault.path().to_path_buf();
    within_a_minute(move || {
        crate::vault::test_access::write_text(&root, "a.md", "saved", crate::vault::BasedOn::ANY)
    })
    .unwrap();
    assert_eq!(
        fs::read_to_string(vault.path().join("a.md")).unwrap(),
        "saved"
    );
}

/// Many saves and many merges at once, each merge writing the note in two
/// steps: every save lands, no two merges interleave, and the note at the end
/// is one whole version. (Reads mid-run are left out: see the test above.)
#[test]
fn saves_and_merges_hammered_together_leave_no_torn_or_lost_note() {
    let bin = fake("git", "printf 'half' > a.md\nprintf ' merged' >> a.md");
    let vault = tempfile::tempdir().unwrap();
    fs::write(vault.path().join("a.md"), "before").unwrap();
    let mut runs = Vec::new();
    for merger in 0..4 {
        let host = host_in(&[bin.path()], None, NO_LIMIT);
        let root = vault.path().to_path_buf();
        runs.push(std::thread::spawn(move || {
            for _ in 0..10 {
                assert_eq!(
                    host.git_in_vault(&root, &args(MERGE)).unwrap().code,
                    Some(0)
                );
            }
            merger
        }));
    }
    for saver in 0..8 {
        let root = vault.path().to_path_buf();
        runs.push(std::thread::spawn(move || {
            for save in 0..25 {
                let text = format!("save {saver}-{save}");
                crate::vault::test_access::write_text(
                    &root,
                    "a.md",
                    &text,
                    crate::vault::BasedOn::ANY,
                )
                .unwrap();
            }
            saver
        }));
    }
    for run in runs {
        run.join().unwrap();
    }
    let last = fs::read_to_string(vault.path().join("a.md")).unwrap();
    assert!(
        last.starts_with("save ") || last == "half merged",
        "{last:?}"
    );
    let left: Vec<_> = fs::read_dir(vault.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(left.len(), 1, "temporaries left behind: {left:?}");
}

// --- Attack on the merge-as-Atlas shape (#87) -------------------------------

fn merge_as(name: &str, email: &str, rest: &[&str]) -> Vec<String> {
    let mut list = vec!["-c", name, "-c", email];
    list.extend_from_slice(rest);
    args(&list)
}

const MERGE_MAIN: &[&str] = &[
    "merge",
    "--no-edit",
    "--allow-unrelated-histories",
    "origin/main",
];

#[test]
fn adversarial_a_merge_author_with_a_break_or_an_option_shape_is_refused() {
    for name in [
        "user.name=A\nB",
        "user.name=A\r",
        "user.name=A\0B",
        "user.name=\n",
        "-user.name=A",
        "--user.name=A",
        " user.name=A",
        "user.name",
        "user.name =A",
    ] {
        let list = merge_as(name, "user.email=a@b", MERGE_MAIN);
        assert!(vet_vault_args(&list).is_err(), "{list:?}");
    }
    for email in [
        "user.email=a@b\n",
        "user.email=a\rb",
        "user.email=\0",
        "-user.email=a@b",
    ] {
        let list = merge_as("user.name=A", email, MERGE_MAIN);
        assert!(vet_vault_args(&list).is_err(), "{list:?}");
    }
}

#[test]
fn adversarial_a_merge_author_key_lookalike_is_refused() {
    for name in [
        "user.n\u{0430}me=A", // Cyrillic a
        "user\u{2024}name=A", // one-dot leader
        "user.name\u{FF1D}A", // fullwidth equals
        "USER.NAME=A",        // git takes it; the shape does not
        "user.Name=A",
        "\u{FEFF}user.name=A", // a byte-order mark in front
        "user.name\u{200B}=A", // zero-width space before the equals
    ] {
        let list = merge_as(name, "user.email=a@b", MERGE_MAIN);
        assert!(vet_vault_args(&list).is_err(), "{list:?}");
    }
}

#[test]
fn adversarial_a_merge_with_swapped_doubled_or_missing_settings_is_refused() {
    let refused: &[&[&str]] = &[
        &[
            "-c",
            "user.email=a@b",
            "-c",
            "user.name=A",
            "merge",
            "--no-edit",
            "--allow-unrelated-histories",
            "origin/main",
        ],
        &[
            "-c",
            "user.name=A",
            "-c",
            "user.name=B",
            "merge",
            "--no-edit",
            "--allow-unrelated-histories",
            "origin/main",
        ],
        &[
            "-c",
            "user.name=A",
            "-c",
            "user.email=a@b",
            "-c",
            "user.name=A",
            "-c",
            "user.email=a@b",
            "merge",
            "--no-edit",
            "--allow-unrelated-histories",
            "origin/main",
        ],
        &[
            "-c",
            "user.name=A",
            "-c",
            "user.email=a@b",
            "-c",
            "core.sshCommand=sh",
            "merge",
            "--no-edit",
            "--allow-unrelated-histories",
            "origin/main",
        ],
        &[
            "-c",
            "core.sshCommand=sh",
            "-c",
            "user.name=A",
            "-c",
            "user.email=a@b",
            "merge",
            "--no-edit",
            "--allow-unrelated-histories",
            "origin/main",
        ],
        &[
            "-cuser.name=A",
            "-c",
            "user.email=a@b",
            "merge",
            "--no-edit",
            "--allow-unrelated-histories",
            "origin/main",
        ],
        &[
            "--config-env=user.name=X",
            "-c",
            "user.email=a@b",
            "merge",
            "--no-edit",
            "--allow-unrelated-histories",
            "origin/main",
        ],
        &[
            "-c",
            "user.name=A",
            "user.email=a@b",
            "merge",
            "--no-edit",
            "--allow-unrelated-histories",
            "origin/main",
        ],
        &[
            "-c",
            "user.name=A",
            "-c",
            "user.email=a@b",
            "merge",
            "--allow-unrelated-histories",
            "--no-edit",
            "origin/main",
        ],
        &[
            "-c",
            "user.name=A",
            "-c",
            "user.email=a@b",
            "commit",
            "--no-edit",
            "--allow-unrelated-histories",
            "origin/main",
        ],
        &[
            "-c",
            "user.name=A",
            "-c",
            "user.email=a@b",
            "pull",
            "--no-edit",
            "--allow-unrelated-histories",
            "origin/main",
        ],
    ];
    for list in refused {
        assert!(!vault_ok(list), "{list:?}");
    }
}

#[test]
fn adversarial_nothing_may_follow_the_branch_of_a_merge_as_atlas() {
    for extra in [
        "--",
        "-s",
        "--strategy=ours",
        "-X",
        "--no-verify",
        "origin/other",
        "HEAD",
        "",
    ] {
        let mut rest = MERGE_MAIN.to_vec();
        rest.push(extra);
        let list = merge_as("user.name=A", "user.email=a@b", &rest);
        assert!(vet_vault_args(&list).is_err(), "{list:?}");
    }
}

#[test]
fn adversarial_a_merge_as_atlas_takes_only_a_plain_branch_of_origin() {
    for reference in [
        "origin/-x",
        "origin/--upload-pack=sh",
        "origin/../evil",
        "origin/a/../b",
        "origin/a b",
        "origin/",
        "origin",
        "origin//main",
        "origin/main.lock",
        "origin/.hidden",
        "origin/main..other",
        "origin/main@{1}",
        "origin/@",
        "origin/main^",
        "origin/main~1",
        "origin/ma:in",
        "origin/main\n",
        "origin/main\u{7f}",
        "upstream/main",
        "refs/remotes/origin/main",
        "Origin/main",
        "-origin/main",
        "main",
    ] {
        let rest = [
            "merge",
            "--no-edit",
            "--allow-unrelated-histories",
            reference,
        ];
        let list = merge_as("user.name=A", "user.email=a@b", &rest);
        assert!(vet_vault_args(&list).is_err(), "{list:?}");
    }
}

/// A commit message and a branch each have a ceiling; an author's name and
/// email are bounded by nothing, so an argument of any size is let through.
#[test]
fn adversarial_a_merge_author_of_ten_thousand_characters_is_refused() {
    let long = "x".repeat(10_000);
    let name = format!("user.name={long}");
    let email = format!("user.email={long}@b");
    assert!(
        vet_vault_args(&merge_as(&name, "user.email=a@b", MERGE_MAIN)).is_err(),
        "a 10,000-character name"
    );
    assert!(
        vet_vault_args(&merge_as("user.name=A", &email, MERGE_MAIN)).is_err(),
        "a 10,000-character email"
    );
}

/// Makes a vault with one commit on `main` and another, unrelated to what
/// HEAD gains next, as `origin/main`, so a merge must make a commit.
fn vault_with_diverged_origin(git: &Path, host: &GitHost, vault: &Path) {
    ok(host
        .git_in_vault(vault, &args(&["init", "--quiet", "--initial-branch=main"]))
        .unwrap());
    fs::write(vault.join("Base.md"), "base\n").unwrap();
    commit(host, vault, "base");
    fs::write(vault.join("Theirs.md"), "theirs\n").unwrap();
    commit(host, vault, "theirs");
    let raw = |list: &[&str]| {
        let output = Command::new(git.join("git"))
            .current_dir(vault)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", vault.join(".git"))
            .args(list)
            .output()
            .unwrap();
        assert!(output.status.success(), "{list:?}: {output:?}");
    };
    raw(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    raw(&["reset", "--quiet", "--hard", "HEAD~1"]);
    fs::write(vault.join("Ours.md"), "ours\n").unwrap();
    commit(host, vault, "ours");
}

/// A home where git refuses to guess who someone is.
fn home_that_never_guesses(work: &Path) -> PathBuf {
    let home = work.join("home");
    fs::create_dir(&home).unwrap();
    fs::write(home.join(".gitconfig"), "[user]\n\tuseConfigOnly = true\n").unwrap();
    home
}

#[test]
fn adversarial_a_real_merge_records_a_unicode_author_exactly() {
    let Some(git_dir) = real_git_dir() else {
        println!("skipped: no git in {GIT_DIRS:?}");
        return;
    };
    let work = tempfile::tempdir().unwrap();
    let host = host_in(
        &[&git_dir],
        Some(home_that_never_guesses(work.path())),
        NO_LIMIT,
    );
    let vault = work.path().join("vault");
    fs::create_dir(&vault).unwrap();
    vault_with_diverged_origin(&git_dir, &host, &vault);

    let name = "DFAI on Zoë’s Mac 🚀 漢字";
    let email = "atlas@zo-s-mac.local";
    ok(host
        .git_in_vault(
            &vault,
            &merge_as(
                &format!("user.name={name}"),
                &format!("user.email={email}"),
                MERGE_MAIN,
            ),
        )
        .unwrap());
    // `log` is not a shape DFAI runs; read it straight from git.
    let log = Command::new(git_dir.join("git"))
        .current_dir(&vault)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .args(["log", "-1", "--format=%an <%ae>%x00%cn <%ce>%x00%P"])
        .output()
        .unwrap();
    assert!(log.status.success(), "{log:?}");
    let stdout = String::from_utf8(log.stdout).unwrap();
    let parts: Vec<&str> = stdout.trim_end().split('\0').collect();
    let who = format!("{name} <{email}>");
    assert_eq!(parts[0], who);
    assert_eq!(parts[1], who);
    assert_eq!(parts[2].split(' ').count(), 2, "a merge commit: {parts:?}");
}

/// A name that reads like more settings is one value: git records it as it
/// is and runs nothing it names.
#[test]
fn adversarial_a_merge_author_that_reads_like_settings_runs_nothing() {
    let Some(git_dir) = real_git_dir() else {
        println!("skipped: no git in {GIT_DIRS:?}");
        return;
    };
    let work = tempfile::tempdir().unwrap();
    let host = host_in(
        &[&git_dir],
        Some(home_that_never_guesses(work.path())),
        NO_LIMIT,
    );
    let vault = work.path().join("vault");
    fs::create_dir(&vault).unwrap();
    vault_with_diverged_origin(&git_dir, &host, &vault);
    let pwned = work.path().join("pwned");
    let name = format!(
        "user.name=A -c core.hooksPath=/tmp -c core.sshCommand=touch {} =x",
        pwned.display()
    );
    let list = merge_as(&name, "user.email=a=b@c", MERGE_MAIN);
    assert!(
        vet_vault_args(&list).is_ok(),
        "one odd value is still one value"
    );
    ok(host.git_in_vault(&vault, &list).unwrap());
    assert!(!pwned.exists(), "nothing named in the value ran");
}

/// PR #630 round 2 attack: a vault with Studio's settings on `origin/main`,
/// pushed, and git run straight (not through the host) to shape refs.
fn vault_with_settings_on_origin(work: &Path, git_dir: &Path) -> (GitHost, PathBuf, String) {
    let home = work.join("home");
    fs::create_dir(&home).unwrap();
    let host = host_in(&[git_dir], Some(home), NO_LIMIT);
    let a = work.join("A");
    let bare = work.join("remote.git");
    fs::create_dir(&a).unwrap();
    let made = Command::new(git_dir.join("git"))
        .args(["init", "--quiet", "--bare", "--initial-branch=main"])
        .arg(&bare)
        .status()
        .unwrap();
    assert!(made.success());
    ok(host
        .git_in_vault(&a, &args(&["init", "--quiet", "--initial-branch=main"]))
        .unwrap());
    fs::create_dir(a.join(".atlas")).unwrap();
    let settings = "---\nautomationsMac: mac-studio\nautomationsMacName: Studio\n---\n".to_string();
    fs::write(a.join(".atlas/settings.md"), &settings).unwrap();
    commit(&host, &a, "DFAI sync set up");
    let remote = bare.display().to_string();
    ok(host
        .git_in_vault(&a, &args(&["remote", "add", "origin", &remote]))
        .unwrap());
    ok(host
        .git_in_vault(
            &a,
            &args(&["push", "--quiet", "--set-upstream", "origin", "HEAD"]),
        )
        .unwrap());
    (host, a, settings)
}

/// PR #630 round 2 attack: `origin/main` is git's short name, which a local
/// branch or tag spelled `origin/main` outranks; the read must still come
/// from `refs/remotes/origin/main`, the settings the last fetch left.
#[test]
fn the_settings_on_github_are_read_from_the_remote_tracking_ref_though_a_local_ref_shares_its_name()
{
    let Some(git_dir) = real_git_dir() else {
        println!("skipped: no git in {GIT_DIRS:?}");
        return;
    };
    for shadow in [["branch", "origin/main"], ["tag", "origin/main"]] {
        let work = tempfile::tempdir().unwrap();
        let (host, a, settings) = vault_with_settings_on_origin(work.path(), &git_dir);
        // A local ref spelled `origin/main`, naming this Mac: not what GitHub holds.
        fs::write(
            a.join(".atlas/settings.md"),
            "---\nautomationsMac: mac-laptop\n---\n",
        )
        .unwrap();
        raw_git(&git_dir, &a, &["commit", "--quiet", "-am", "local only"]);
        raw_git(&git_dir, &a, &[shadow[0], shadow[1], "HEAD"]);

        let read = host.git_in_vault(
            &a,
            &args(&["cat-file", "blob", "origin/main:.atlas/settings.md"]),
        );
        let read = read.map(|output| output.stdout);
        assert!(
            matches!(&read, Ok(text) if *text == settings) || read.is_err(),
            "a local {} named origin/main was read as GitHub's settings: {read:?}",
            shadow[0]
        );
    }
}

/// PR #630 round 2 attack: with HEAD detached, or the branch tracking a
/// remote not named origin, nothing is read as GitHub's settings.
#[test]
fn the_settings_on_github_are_not_read_with_head_detached() {
    let Some(git_dir) = real_git_dir() else {
        println!("skipped: no git in {GIT_DIRS:?}");
        return;
    };
    let work = tempfile::tempdir().unwrap();
    let (host, a, _) = vault_with_settings_on_origin(work.path(), &git_dir);
    raw_git(&git_dir, &a, &["checkout", "--quiet", "--detach", "HEAD"]);
    let refused = host
        .git_in_vault(
            &a,
            &args(&["cat-file", "blob", "origin/main:.atlas/settings.md"]),
        )
        .unwrap_err();
    assert!(refused.contains("not the branch checked out"), "{refused}");
}

/// PR #630 round 2 attack: branch spellings meant to break `<rev>:<path>`, or
/// to reach another object, are refused by the shape before git runs.
#[test]
fn reading_the_settings_on_github_refuses_branch_spellings_that_reach_another_object() {
    for branch in [
        "a:b",
        "a b",
        "a\0b",
        "a\nb",
        "a\tb",
        "main@{u}",
        "@",
        "main^{tree}",
        "main~",
        "-",
        "--output=x",
        ".hidden",
        "a/.b",
        "a.lock",
        "a/",
        "/a",
        "a//b",
        "a.",
        "a\\b",
        "a*",
        "a?",
        "a[b]",
        "\u{7f}",
    ] {
        let arg = format!("origin/{branch}:.atlas/settings.md");
        assert!(!vault_ok(&["cat-file", "blob", &arg]), "{arg:?}");
    }
    for path in [
        ".atlas/settings.md/",
        ".atlas/Settings.md",
        ".atlas/settings.MD",
        "./.atlas/settings.md",
        ".atlas/./settings.md",
        ".atlas/../.atlas/settings.md",
        "/.atlas/settings.md",
        " .atlas/settings.md",
        ".atlas/settings.md ",
    ] {
        let arg = format!("origin/main:{path}");
        assert!(!vault_ok(&["cat-file", "blob", &arg]), "{arg:?}");
    }
    // Unicode is a branch git allows, and still only that one path.
    assert!(vault_ok(&[
        "cat-file",
        "blob",
        "origin/café/日本:.atlas/settings.md"
    ]));
}
