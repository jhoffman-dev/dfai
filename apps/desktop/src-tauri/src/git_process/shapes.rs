//! The argument shapes the host will run `git` and `gh` with (U-29).
//!
//! The webview is the untrusted side (ADR-0017), and a free-form `git` command
//! line is code execution: `--upload-pack=…`, `-c core.sshCommand=…`, an
//! `ext::` URL. So, as with Claude Code (ADR-0021), the host holds every shape
//! whole and in order, and checks each value slot against what it may hold.
//! Which shape to run, and when, is TypeScript's; the host only obeys the list.

/// Whether a run talks to another machine, which is what its time limit follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    Local,
    Network,
}

/// One argument of a shape: a fixed word, or a value that must pass a check.
#[derive(Debug, Clone, Copy)]
enum Slot {
    Is(&'static str),
    /// A commit message.
    Message,
    /// A remote's address.
    Url,
    /// A remote-tracking branch, `origin/<branch>`.
    Ref,
    /// A path inside the vault, after `--`.
    VaultPath,
    /// `-c` config value for a commit's or merge's author: the key, then a
    /// non-empty value without line breaks, at most `MAX_IDENTITY` bytes.
    Identity(&'static str),
    /// The folder a clone makes: one new name.
    CloneName,
    /// `<mode>,<blob id>,<path in the vault>`, what `--cacheinfo` takes as one argument.
    CacheInfo,
    /// What `ls-tree` lists: `HEAD`, `origin/<branch>` or a commit id.
    Rev,
    /// A local branch's new name, as git allows it.
    Branch,
    /// `--filter=blob:limit=<bytes>`.
    BlobLimit,
    /// A blob's id, as `cat-file blob` takes it.
    Blob,
    /// The settings note on GitHub as the last fetch left it:
    /// `origin/<branch>:.atlas/settings.md`, that path and no other.
    RemoteSettings,
}

use Slot::{
    Blob, BlobLimit, Branch, CacheInfo, CloneName, Identity, Is, Message, Ref, RemoteSettings, Rev,
    Url, VaultPath,
};

type Shape = (&'static [Slot], Reach);

/// What may be run in the open vault.
const IN_VAULT: &[Shape] = &[
    (&[Is("rev-parse"), Is("--show-toplevel")], Reach::Local),
    (
        &[Is("init"), Is("--quiet"), Is("--initial-branch=main")],
        Reach::Local,
    ),
    (
        &[
            Is("status"),
            Is("--porcelain=v2"),
            Is("--branch"),
            Is("-z"),
            Is("--untracked-files=all"),
        ],
        Reach::Local,
    ),
    (&[Is("add"), Is("--all")], Reach::Local),
    (
        &[
            Is("commit"),
            Is("--quiet"),
            Is("--no-verify"),
            Is("-m"),
            Message,
        ],
        Reach::Local,
    ),
    (
        &[
            Is("-c"),
            Identity("user.name="),
            Is("-c"),
            Identity("user.email="),
            Is("commit"),
            Is("--quiet"),
            Is("--no-verify"),
            Is("-m"),
            Message,
        ],
        Reach::Local,
    ),
    (&[Is("fetch"), Is("--quiet"), Is("origin")], Reach::Network),
    (
        &[
            Is("merge"),
            Is("--no-edit"),
            Is("--allow-unrelated-histories"),
            Ref,
        ],
        Reach::Local,
    ),
    // A merge that makes a commit, by the same author a commit would have.
    (
        &[
            Is("-c"),
            Identity("user.name="),
            Is("-c"),
            Identity("user.email="),
            Is("merge"),
            Is("--no-edit"),
            Is("--allow-unrelated-histories"),
            Ref,
        ],
        Reach::Local,
    ),
    (
        &[
            Is("push"),
            Is("--quiet"),
            Is("--set-upstream"),
            Is("origin"),
            Is("HEAD"),
        ],
        Reach::Network,
    ),
    (&[Is("remote"), Is("get-url"), Is("origin")], Reach::Local),
    (&[Is("remote"), Is("add"), Is("origin"), Url], Reach::Local),
    (
        &[Is("remote"), Is("set-url"), Is("origin"), Url],
        Reach::Local,
    ),
    (
        &[Is("symbolic-ref"), Is("--quiet"), Is("--short"), Is("HEAD")],
        Reach::Local,
    ),
    (
        &[Is("log"), Is("-1"), Is("--format=%H%x00%ct")],
        Reach::Local,
    ),
    // The subject of the other Macs' last commit, which names the Mac a
    // conflict copy is from. `--` ends the revisions, so nothing after is one.
    (
        &[Is("log"), Is("-1"), Is("--format=%s"), Ref, Is("--")],
        Reach::Local,
    ),
    (
        &[Is("checkout"), Is("--ours"), Is("--"), VaultPath],
        Reach::Local,
    ),
    (
        &[Is("checkout"), Is("--theirs"), Is("--"), VaultPath],
        Reach::Local,
    ),
    (&[Is("config"), Is("--get"), Is("user.name")], Reach::Local),
    (&[Is("config"), Is("--get"), Is("user.email")], Reach::Local),
    (
        &[Is("rev-parse"), Is("--verify"), Is("--quiet"), Ref],
        Reach::Local,
    ),
    // Whether a merge is under way that a quit cut off before its commit.
    (
        &[
            Is("rev-parse"),
            Is("--verify"),
            Is("--quiet"),
            Is("MERGE_HEAD"),
        ],
        Reach::Local,
    ),
    // Files not in the index, compared by exact spelling: on a Mac's
    // case-insensitive disk, a note renamed only in case shows here.
    (
        &[
            Is("-c"),
            Is("core.ignoreCase=false"),
            Is("ls-files"),
            Is("-z"),
            Is("--others"),
            Is("--exclude-standard"),
        ],
        Reach::Local,
    ),
    // The index, with each entry's mode, id and stage.
    (&[Is("ls-files"), Is("-z"), Is("--stage")], Reach::Local),
    (&[Is("mv"), Is("--"), VaultPath, VaultPath], Reach::Local),
    (&[Is("ls-tree"), Is("-r"), Is("-z"), Rev], Reach::Local),
    (&[Is("merge-base"), Is("HEAD"), Ref], Reach::Local),
    (
        &[Is("hash-object"), Is("--no-filters"), Is("--"), VaultPath],
        Reach::Local,
    ),
    // One side of a settings file both Macs changed, to merge by its keys.
    (&[Is("cat-file"), Is("blob"), Blob], Reach::Local),
    // Who the settings on GitHub name, as the last fetch left them (#630):
    // one blob, never a listing of the tree.
    (&[Is("cat-file"), Is("blob"), RemoteSettings], Reach::Local),
    // A blob already in the repository, put in the index under a new path.
    (
        &[
            Is("update-index"),
            Is("--add"),
            Is("--cacheinfo"),
            CacheInfo,
        ],
        Reach::Local,
    ),
    // Writes a path from the index; never over a file that is there.
    (&[Is("checkout-index"), Is("--"), VaultPath], Reach::Local),
    (
        &[Is("rm"), Is("--cached"), Is("--quiet"), Is("--"), VaultPath],
        Reach::Local,
    ),
    (
        &[Is("reset"), Is("--quiet"), Is("--"), VaultPath],
        Reach::Local,
    ),
    (
        &[Is("reset"), Is("--quiet"), Is("--soft"), Ref],
        Reach::Local,
    ),
    // The blobs at or over a size in commits not on the remote yet, marked `~`.
    (
        &[
            Is("rev-list"),
            Is("--objects"),
            BlobLimit,
            Is("--filter-print-omitted"),
            Is("HEAD"),
            Is("--not"),
            Is("--remotes=origin"),
        ],
        Reach::Local,
    ),
    // The remote's default branch.
    (
        &[Is("ls-remote"), Is("--symref"), Is("origin"), Is("HEAD")],
        Reach::Network,
    ),
    (&[Is("branch"), Is("-m"), Branch], Reach::Local),
];

/// What may be run in a folder that is not the vault: asking whether it sits
/// in a repository, and cloning a vault into it.
const IN_FOLDER: &[Shape] = &[
    (&[Is("rev-parse"), Is("--show-toplevel")], Reach::Local),
    // What a repository holds, before anything is cloned: an empty one has no branches.
    (
        &[Is("ls-remote"), Is("--heads"), Is("--"), Url],
        Reach::Network,
    ),
    (
        &[
            Is("clone"),
            Is("--quiet"),
            Is("--origin"),
            Is("origin"),
            Is("--"),
            Url,
            CloneName,
        ],
        Reach::Network,
    ),
];

const MAX_MESSAGE: usize = 1000;
const MAX_BRANCH: usize = 200;
const MAX_IDENTITY: usize = 256;
const MAX_URL: usize = 2048;
const MAX_NAME: usize = 255;
const MAX_REPO_NAME: usize = 100;

/// The vault commands that rewrite notes in the working tree: a merge, taking
/// one side of a conflict, writing a path from the index, and a move. The rest
/// read, or change only what is inside `.git`, which no save touches.
const WRITES_TREE: &[&str] = &["merge", "checkout", "checkout-index", "mv"];

/// The git command the arguments run, past any leading `-c <key>=<value>`.
fn verb_of(args: &[String]) -> Option<&str> {
    let mut rest = args;
    while let [flag, _setting, after @ ..] = rest {
        if flag != "-c" {
            break;
        }
        rest = after;
    }
    rest.first().map(String::as_str)
}

/// Whether vetted vault arguments rewrite notes, and so must wait for the
/// vault's change turn. Network runs never do: a turn held over a fetch would
/// hold every save behind it.
pub fn writes_working_tree(args: &[String]) -> bool {
    verb_of(args).is_some_and(|verb| WRITES_TREE.contains(&verb))
}

/// The file a vetted `checkout --ours/--theirs` writes over whatever is there,
/// which the sync must say what it saw of: a save made since it looked is
/// the person's, and is not written over. `checkout-index` and `merge` need
/// no such word, as git itself never writes them over a file it did not make.
pub fn overwritten_path(args: &[String]) -> Option<&str> {
    (verb_of(args) == Some("checkout"))
        .then(|| args.last().map(String::as_str))
        .flatten()
}

/// Checks arguments meant for the open vault; says how far the run reaches.
pub fn vet_vault_args(args: &[String]) -> Result<Reach, String> {
    vet(IN_VAULT, args)
}

/// Checks arguments meant for a folder outside the vault.
pub fn vet_folder_args(args: &[String]) -> Result<Reach, String> {
    vet(IN_FOLDER, args)
}

/// The folder a clone would make, when these are clone arguments.
pub fn clone_name(args: &[String]) -> Option<&str> {
    (args.first().map(String::as_str) == Some("clone"))
        .then(|| args.last().map(String::as_str))
        .flatten()
}

/// The address a clone copies from, when these are clone arguments.
pub fn clone_url(args: &[String]) -> Option<&str> {
    clone_name(args)?;
    args.get(args.len().checked_sub(2)?).map(String::as_str)
}

/// The address `remote add` or `remote set-url` would point the vault at.
pub fn new_remote_url(args: &[String]) -> Option<&str> {
    match args {
        [remote, verb, origin, url]
            if remote == "remote" && (verb == "add" || verb == "set-url") && origin == "origin" =>
        {
            Some(url.as_str())
        }
        _ => None,
    }
}

/// Checks a name for `gh repo create`: GitHub's own characters, never an option.
pub fn vet_repo_name(name: &str) -> Result<(), String> {
    let allowed = name
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'));
    if name.is_empty()
        || name.len() > MAX_REPO_NAME
        || !allowed
        || name.starts_with('-')
        || name.starts_with('.')
    {
        return Err(format!("{name:?} is not a repository name DFAI creates"));
    }
    Ok(())
}

fn vet(shapes: &[Shape], args: &[String]) -> Result<Reach, String> {
    let mut closest: Option<(usize, String)> = None;
    for (slots, reach) in shapes {
        match fits(slots, args) {
            Ok(()) => return Ok(*reach),
            Err((matched, why)) => {
                if closest.as_ref().map_or(true, |(best, _)| matched > *best) {
                    closest = Some((matched, why));
                }
            }
        }
    }
    let why = closest.map_or_else(|| "no shape".to_string(), |(_, why)| why);
    Err(format!(
        "the arguments are not ones DFAI runs git with: {why}"
    ))
}

/// Whether the arguments are this shape; if not, how many led in and why.
fn fits(slots: &[Slot], args: &[String]) -> Result<(), (usize, String)> {
    for (at, slot) in slots.iter().enumerate() {
        let Some(arg) = args.get(at) else {
            return Err((at, format!("argument {at} is missing")));
        };
        check(*slot, arg).map_err(|why| (at, format!("argument {at}: {why}")))?;
    }
    if args.len() != slots.len() {
        return Err((
            slots.len(),
            format!("{} arguments, not {}", slots.len(), args.len()),
        ));
    }
    Ok(())
}

fn check(slot: Slot, arg: &str) -> Result<(), String> {
    let ok = match slot {
        Is(fixed) => arg == fixed,
        Message => is_message(arg),
        Url => is_url(arg),
        Ref => is_remote_branch(arg),
        VaultPath => is_vault_path(arg),
        Identity(key) => arg.strip_prefix(key).is_some_and(|value| {
            !value.is_empty() && value.len() <= MAX_IDENTITY && !has_break(value)
        }),
        CloneName => is_clone_name(arg),
        CacheInfo => is_cache_info(arg),
        Rev => arg == "HEAD" || is_remote_branch(arg) || is_oid(arg),
        Branch => is_branch(arg),
        Blob => is_oid(arg),
        RemoteSettings => remote_settings_branch_of(arg).is_some(),
        BlobLimit => arg
            .strip_prefix("--filter=blob:limit=")
            .is_some_and(|bytes| {
                !bytes.is_empty() && bytes.len() <= 12 && bytes.bytes().all(|b| b.is_ascii_digit())
            }),
    };
    if ok {
        Ok(())
    } else {
        Err(format!("{arg:?} does not fit {slot:?}"))
    }
}

fn has_break(value: &str) -> bool {
    value.contains(['\n', '\r', '\0'])
}

fn is_message(message: &str) -> bool {
    !message.is_empty()
        && !message.starts_with('-')
        && !message.contains('\0')
        && message.chars().count() <= MAX_MESSAGE
}

/// Where the settings note sits in every vault.
const SETTINGS_PATH: &str = ".atlas/settings.md";

/// The branch of `origin/<branch>:.atlas/settings.md`, when the argument is
/// exactly that; the branch spelled as git allows, never an option or a range.
fn remote_settings_branch_of(arg: &str) -> Option<&str> {
    let rev = arg.strip_suffix(SETTINGS_PATH)?.strip_suffix(':')?;
    let branch = rev.strip_prefix("origin/")?;
    is_branch(branch).then_some(branch)
}

/// The branch a vetted read of the settings on GitHub names, which the host
/// holds to the branch checked out before it runs.
pub fn remote_settings_branch(args: &[String]) -> Option<&str> {
    match args {
        [verb, kind, arg] if verb == "cat-file" && kind == "blob" => remote_settings_branch_of(arg),
        _ => None,
    }
}

/// `origin/<branch>`, spelled as git allows and never as an option or a range.
fn is_remote_branch(reference: &str) -> bool {
    reference.strip_prefix("origin/").is_some_and(is_branch)
}

/// A branch name as `git check-ref-format --branch` allows it, and never an
/// option: no `..` or `@{`, no control character or any of ` ~^:?*[\`, no
/// empty part, none that starts with `.` or ends with `.lock`, no `.` at the
/// end, and not `@` alone.
fn is_branch(branch: &str) -> bool {
    let plain = !branch.bytes().any(|byte| {
        byte < 0x20
            || byte == 0x7f
            || matches!(byte, b' ' | b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
    });
    plain
        && !branch.is_empty()
        && branch.len() <= MAX_BRANCH
        && branch != "@"
        && !branch.contains("..")
        && !branch.contains("@{")
        && !branch.starts_with('-')
        && !branch.ends_with('.')
        && branch
            .split('/')
            .all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
}

/// A regular file, an executable or a link, its blob, and where it goes.
fn is_cache_info(arg: &str) -> bool {
    let mut parts = arg.splitn(3, ',');
    let (Some(mode), Some(oid), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    matches!(mode, "100644" | "100755" | "120000") && is_oid(oid) && is_vault_path(path)
}

/// A full object id: SHA-1's 40 hex digits, or SHA-256's 64.
fn is_oid(id: &str) -> bool {
    (id.len() == 40 || id.len() == 64)
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// A path inside the vault, relative to it, that stays out of `.git`.
pub fn is_vault_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\0')
        && path.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && !segment.eq_ignore_ascii_case(".git")
        })
}

fn is_clone_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && !name.starts_with('.')
        && !name.starts_with('-')
        && !name.contains(['/', '\0'])
}

/// A remote's address: `https://`, `ssh://`, `user@host:path`, or a folder on
/// disk. Never a transport that runs something (`ext::`), never an option.
pub fn is_url(url: &str) -> bool {
    if url.is_empty()
        || url.len() > MAX_URL
        || url.starts_with('-')
        || url.contains("::")
        || url.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return false;
    }
    if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("ssh://"))
    {
        return has_plain_host(rest);
    }
    url.starts_with('/') || is_scp_like(url)
}

/// Whether what follows `scheme://` names a host, after an optional `user@`,
/// that is not an option: `ssh://-oProxyCommand=…` hands the host to ssh as
/// one (CVE-2017-1000117). Git refuses it too; this is the host's own line.
fn has_plain_host(rest: &str) -> bool {
    let authority = rest.split('/').next().unwrap_or_default();
    let (user, host) = authority
        .rsplit_once('@')
        .map_or((None, authority), |(user, host)| (Some(user), host));
    !host.is_empty() && !host.starts_with('-') && user.map_or(true, is_plain_user)
}

/// What comes before `@`: a user name and nothing else. A password or a
/// token there would be kept in `.git/config` and handed back to the
/// webview (ADR-0017). GitHub user names run to 39 characters.
fn is_plain_user(user: &str) -> bool {
    !user.is_empty()
        && user.len() <= 39
        && user
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// `git@github.com:owner/repo.git`.
fn is_scp_like(url: &str) -> bool {
    let Some((user, rest)) = url.split_once('@') else {
        return false;
    };
    let Some((host, path)) = rest.split_once(':') else {
        return false;
    };
    let user_ok = !user.is_empty()
        && user
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    let host_ok = !host.is_empty()
        && host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'));
    user_ok && host_ok && !path.is_empty() && !path.starts_with('-')
}
