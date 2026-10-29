//! Scoped read access to the user's vault.
//!
//! This module is the only place the app touches the filesystem. It translates
//! between vault-relative paths and real ones, and refuses anything that resolves
//! outside the chosen vault root. It holds no product rules: what a note *means*
//! is decided in TypeScript.

use std::cell::Cell;
use std::collections::HashSet;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Refuse to read anything larger than this as text; a vault note is never this big,
/// and a multi-gigabyte file would freeze the webview.
const MAX_TEXT_BYTES: u64 = 10 * 1024 * 1024;

/// Images are held in memory while they are displayed, so the ceiling is lower
/// than for text and a stray video file cannot exhaust memory.
pub(crate) const MAX_BINARY_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultLocation {
    pub absolute_path: String,
    pub name: String,
}

/// A note's text together with the modification time it was read at. The client
/// hands that time back when saving, so an edit made elsewhere is never clobbered.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteContents {
    pub text: String,
    pub modified: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    /// Only meaningful for notes; the tree ignores both.
    pub modified: u64,
    pub size: u64,
}

#[derive(Default)]
pub struct VaultState(Mutex<Option<PathBuf>>);

impl VaultState {
    /// The open vault's root, for code outside this module that needs to reach it.
    pub fn root(&self) -> Option<PathBuf> {
        self.get()
    }

    /// The guarded value is one path. A thread that panicked while holding this
    /// lock cannot have left that path half-written, so the poison flag says
    /// nothing useful here — and honouring it would turn one panic somewhere
    /// else into every later vault call panicking for the rest of the session.
    fn open(&self) -> MutexGuard<'_, Option<PathBuf>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn get(&self) -> Option<PathBuf> {
        self.open().clone()
    }

    /// The open vault, or `root` when none is: a vault opened meanwhile wins
    /// over the one remembered from the last launch.
    fn get_or_set(&self, root: PathBuf) -> PathBuf {
        self.open().get_or_insert(root).clone()
    }
}

pub(crate) fn location_of(root: &Path) -> VaultLocation {
    VaultLocation {
        absolute_path: root.to_string_lossy().into_owned(),
        name: root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
    }
}

fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("no config directory: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("cannot create config directory: {error}"))?;
    Ok(dir.join("vault.json"))
}

fn remember(app: &AppHandle, location: &VaultLocation) -> Result<(), String> {
    let path = config_file(app)?;
    let json = serde_json::to_string_pretty(location).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| format!("cannot save vault choice: {error}"))
}

fn recall(app: &AppHandle) -> Option<VaultLocation> {
    let path = config_file(app).ok()?;
    let json = fs::read_to_string(path).ok()?;
    let location: VaultLocation = serde_json::from_str(&json).ok()?;
    // A remembered vault may have been moved or deleted since last launch.
    Path::new(&location.absolute_path)
        .is_dir()
        .then_some(location)
}

/// Resolves a vault-relative path to a real one, or refuses.
///
/// Two checks, because neither alone is enough: the lexical check rejects `..`
/// before it touches the disk, and the canonical check catches a symlink whose
/// target sits outside the vault.
pub(crate) fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.contains('\0') {
        return Err("path contains a null byte".into());
    }
    refuse_git_folder(relative)?;

    let mut resolved = root.to_path_buf();
    for segment in relative.split('/').filter(|segment| !segment.is_empty()) {
        match Path::new(segment).components().next() {
            Some(Component::Normal(name)) => resolved.push(name),
            _ => return Err(format!("path segment {segment:?} is not allowed")),
        }
    }

    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("vault is unreadable: {error}"))?;
    let canonical = resolved
        .canonicalize()
        .map_err(|error| format!("no such entry: {error}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("path escapes the vault".into());
    }
    refuse_hidden_detour(&canonical_root, &canonical, relative)?;
    refuse_git_folder_reached(&canonical_root, &canonical)?;
    Ok(canonical)
}

/// Refuses any path into a `.git` folder, or at a `.git` file, whatever case
/// it is spelled in.
///
/// DFAI runs `git` in the vault (U-29), and git trusts what is in `.git`: a
/// `.git/config` naming `core.sshCommand`, or a `.git` file pointing at another
/// repository, is a program run the next time the vault syncs. The webview is
/// the untrusted side (ADR-0017), so no vault read or write may reach there;
/// only `git` itself, run by the host, touches it. `.gitignore` is not `.git`.
fn refuse_git_folder(relative: &str) -> Result<(), String> {
    if relative
        .split('/')
        .any(|segment| segment.eq_ignore_ascii_case(".git"))
    {
        return Err("git's own folder is not part of the vault".into());
    }
    Ok(())
}

/// The same refusal for where a path lands once links are followed.
fn refuse_git_folder_reached(canonical_root: &Path, canonical: &Path) -> Result<(), String> {
    let Ok(reached) = canonical.strip_prefix(canonical_root) else {
        return Ok(());
    };
    refuse_git_folder(&reached.to_string_lossy())
}

/// Refuses a path that a link carried into a hidden folder or file — `.atlas`,
/// `.git`, `Projects/.obsidian` — that the path itself did not name.
///
/// The TypeScript side keeps its callers out of any hidden segment, however
/// deep (`isUserSpace`), by what a path says; a link in user space would
/// otherwise let a path that says `Notes/…` read or write one. This decides
/// nothing about which folders matter: any hidden one is reached only by naming it.
fn refuse_hidden_detour(
    canonical_root: &Path,
    canonical: &Path,
    relative: &str,
) -> Result<(), String> {
    let Ok(reached) = canonical.strip_prefix(canonical_root) else {
        return Ok(());
    };
    let named: Vec<&str> = relative
        .split('/')
        .filter(|segment| segment.starts_with('.'))
        .collect();
    let detour = reached.components().any(|component| {
        let Component::Normal(segment) = component else {
            return false;
        };
        let segment = segment.to_string_lossy();
        segment.starts_with('.')
            && !named
                .iter()
                .any(|named| named.eq_ignore_ascii_case(&segment))
    });
    if detour {
        return Err("path reaches a hidden folder through a link".into());
    }
    Ok(())
}

/// Resolves a path for a file that does not exist yet.
///
/// `resolve` canonicalises the target, which a new file cannot satisfy. Here the
/// *parent* is canonicalised and checked instead, so a new note still cannot be
/// written outside the vault — including through a symlinked folder.
pub(crate) fn resolve_new(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.contains('\0') {
        return Err("path contains a null byte".into());
    }
    refuse_git_folder(relative)?;

    let mut segments = Vec::new();
    for segment in relative.split('/').filter(|segment| !segment.is_empty()) {
        match Path::new(segment).components().next() {
            Some(Component::Normal(name)) => segments.push(name.to_os_string()),
            _ => return Err(format!("path segment {segment:?} is not allowed")),
        }
    }

    let name = segments.pop().ok_or("a note needs a name")?;
    let mut parent = root.to_path_buf();
    for segment in &segments {
        parent.push(segment);
    }

    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("vault is unreadable: {error}"))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|_| "that folder does not exist".to_string())?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err("path escapes the vault".into());
    }
    let file = canonical_parent.join(name);
    refuse_hidden_detour(&canonical_root, &file, relative)?;
    refuse_git_folder_reached(&canonical_root, &file)?;
    Ok(file)
}

/// Creates a note, refusing to touch one that is already there.
///
/// Written whole beside it first and renamed into place, so a read never
/// finds the note empty while its text is still being written. The rename is
/// exclusive, so an existing note is never overwritten and two creations
/// racing cannot both win.
///
/// Reports the new note's modification time, as `write_text` does a save's: a
/// rename keeps the time the temporary was given, so it is the note's own.
fn create_note_at(root: &Path, relative: &str, contents: &str) -> Result<u64, String> {
    let _turn = change_turn();
    let file = resolve_new(root, relative)?;
    let temporary = temporary_beside(&file)?;

    // Nothing is replaced, so the time the clock gives is kept.
    let modified = write_temporary(&temporary, contents.as_bytes(), 0)
        .map_err(|error| format!("cannot write the note: {error}"))?;
    rename_exclusive(&temporary, &file)
        .map(|()| modified)
        .map_err(|error| {
            let _ = fs::remove_file(&temporary); // Best effort; the creation already failed.
            match error.kind() {
                ErrorKind::AlreadyExists => "a note with that name already exists".to_string(),
                _ => format!("cannot create the note: {error}"),
            }
        })
}

/// The name a note's new text is written under before it is renamed into place.
fn temporary_beside(file: &Path) -> Result<PathBuf, String> {
    let directory = file.parent().ok_or("note has no parent directory")?;
    let name = file.file_name().ok_or("note has no file name")?;
    Ok(directory.join(format!(".{}.atlas-tmp", name.to_string_lossy())))
}

/// Renames `from` to `to` only if nothing is at `to`, decided by the kernel
/// in the rename itself, so nothing can take the name between a check and
/// the move.
#[cfg(target_os = "macos")]
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    let (from, to) = (c_path(from)?, c_path(to)?);
    // SAFETY: both are NUL-terminated paths that outlive the call.
    let status = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    let (from, to) = (c_path(from)?, c_path(to)?);
    // SAFETY: both are NUL-terminated paths that outlive the call.
    let status = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Elsewhere there is no exclusive rename, and the check is as close as it gets.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(to).is_ok() {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }
    fs::rename(from, to)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn c_path(path: &Path) -> std::io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "a path holds a NUL"))
}

#[tauri::command]
pub async fn create_note(
    app: AppHandle,
    path: String,
    contents: String,
    vault: String,
) -> Result<u64, String> {
    off_main(move || {
        let modified = change_in_vault(&app.state::<VaultState>(), Some(&vault), |root| {
            create_note_at(root, &path, &contents)
        })?;
        log::info!("created {path}");
        Ok(modified)
    })
    .await
}

pub(crate) fn root_of(state: &State<'_, VaultState>) -> Result<PathBuf, String> {
    state.get().ok_or_else(|| "no vault is open".to_string())
}

/// The root a write lands in, refused when it was meant for a vault that is no
/// longer the open one.
///
/// Paths are relative to a vault and only one is open at a time, so a write that
/// arrives after a switch names a same-named note in the other vault. Which vault
/// a write belongs to is the caller's to say (R14-01); this only compares, the way
/// `expected_modified` is compared. A write that names no vault is refused
/// (R14-04): the typed commands cannot be called without one, and this holds the
/// same line for the binary write, whose vault arrives as an optional header.
pub(crate) fn root_for_write(
    open: Option<PathBuf>,
    meant_for: Option<&str>,
) -> Result<PathBuf, String> {
    let root = open.ok_or_else(|| "no vault is open".to_string())?;
    let meant =
        meant_for.ok_or_else(|| "a write must name the vault it is meant for".to_string())?;
    if Path::new(meant) != root {
        return Err("another vault was opened before this could be written".into());
    }
    Ok(root)
}

#[tauri::command]
pub async fn pick_vault(app: AppHandle) -> Result<Option<VaultLocation>, String> {
    // Waits on the blocking pool for as long as the dialog is open, so it parks
    // neither the window nor a worker of the async runtime; the dialog plugin
    // hops back to the main thread on its own.
    // Picking only reports a choice — whether to keep it is decided in the use-case.
    let Some(picked) = off_main(move || Ok(app.dialog().file().blocking_pick_folder())).await?
    else {
        return Ok(None);
    };
    let root = picked
        .into_path()
        .map_err(|error| format!("unusable folder: {error}"))?;
    Ok(Some(location_of(&root)))
}

/// The vault is open once this answers: a write the frontend sends after
/// awaiting it lands in the new vault, and none lands in the old one.
#[tauri::command]
pub async fn open_vault(app: AppHandle, location: VaultLocation) -> Result<(), String> {
    off_main(move || {
        switch_vault(&app.state::<VaultState>(), &location, |location| {
            remember(&app, location)
        })
    })
    .await
}

/// Opens the vault at `location`, as a change of its own: a change already
/// running finishes in the vault it was meant for, and one whose turn comes
/// after finds the new vault open and is refused (`change_in_vault`).
///
/// Remembered and opened under the vault's lock, so the vault remembered for
/// the next launch is always the one open; one that cannot be remembered is
/// not opened.
pub(crate) fn switch_vault(
    state: &VaultState,
    location: &VaultLocation,
    remember: impl FnOnce(&VaultLocation) -> Result<(), String>,
) -> Result<(), String> {
    let root = PathBuf::from(&location.absolute_path);
    if !root.is_dir() {
        return Err(format!("{} is not a folder", location.absolute_path));
    }
    let _turn = change_turn();
    let mut open = state.open();
    remember(location)?;
    *open = Some(root);
    log::info!("vault opened: {}", location.absolute_path);
    Ok(())
}

#[tauri::command]
pub async fn current_vault(app: AppHandle) -> Result<Option<VaultLocation>, String> {
    off_main(move || Ok(restore_vault(&app.state::<VaultState>(), || recall(&app)))).await
}

/// The open vault, or the one remembered from the last launch when none is.
fn restore_vault(
    state: &VaultState,
    recall: impl FnOnce() -> Option<VaultLocation>,
) -> Option<VaultLocation> {
    if let Some(root) = state.get() {
        return Some(location_of(&root));
    }
    let remembered = PathBuf::from(recall()?.absolute_path);
    let open = state.get_or_set(remembered.clone());
    if open == remembered {
        log::info!("vault restored: {}", open.display());
    }
    Some(location_of(&open))
}

/// Lists one directory's immediate children. Entries whose metadata cannot be read
/// are skipped rather than failing the whole listing: a broken symlink in a vault
/// should not make the folder unopenable.
fn list_entries(root: &Path, path: &str) -> Result<Vec<VaultEntry>, String> {
    let directory = resolve(root, path)?;

    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| format!("cannot read: {error}"))? {
        let Ok(entry) = entry else { continue };
        // fs::metadata follows symlinks, so a link to a folder lists as a folder and a
        // broken link is skipped. DirEntry::metadata would describe the link itself.
        let Ok(metadata) = fs::metadata(entry.path()) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let child = if path.is_empty() {
            name.clone()
        } else {
            format!("{path}/{name}")
        };
        entries.push(VaultEntry {
            name,
            path: child,
            kind: if metadata.is_dir() {
                "directory"
            } else {
                "file"
            },
            modified: modified_ms(&metadata).unwrap_or(0),
            size: metadata.len(),
        });
    }
    Ok(entries)
}

fn modified_ms(metadata: &fs::Metadata) -> Result<u64, String> {
    metadata
        .modified()
        .map_err(|error| format!("no modification time: {error}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .map_err(|error| format!("modification time is before the epoch: {error}"))
}

fn refuse_larger(length: u64, limit: u64) -> Result<(), String> {
    if length > limit {
        return Err(format!(
            "file is {} MB, larger than the {} MB limit",
            length / 1024 / 1024,
            limit / 1024 / 1024
        ));
    }
    Ok(())
}

/// A file's bytes and the metadata of that same version, refused when it is a
/// folder or larger than `limit`.
///
/// Both come from one open handle: a save renames a new file over the note, and
/// the handle keeps the file it opened, so a read racing a save can never pair
/// the new text with the old time (which would make the next save look stale)
/// or the old text with the new time (which would let it clobber the new one).
/// The limit holds while reading too, for a file that grows once opened.
fn read_one_version(file: &Path, limit: u64) -> Result<(Vec<u8>, fs::Metadata), String> {
    let handle = fs::File::open(file).map_err(|error| format!("cannot read: {error}"))?;
    let metadata = handle
        .metadata()
        .map_err(|error| format!("cannot read: {error}"))?;
    if metadata.is_dir() {
        return Err("that is a directory".into());
    }
    refuse_larger(metadata.len(), limit)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    handle
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read: {error}"))?;
    refuse_larger(bytes.len() as u64, limit)?;
    Ok((bytes, metadata))
}

/// Reads a note and the modification time of that same version.
fn read_text(root: &Path, path: &str) -> Result<NoteContents, String> {
    let _whole = notes_whole();
    let (bytes, metadata) = read_one_version(&resolve(root, path)?, MAX_TEXT_BYTES)?;
    let text = String::from_utf8(bytes).map_err(|_| "not a text file".to_string())?;
    Ok(NoteContents {
        text,
        modified: modified_ms(&metadata)?,
    })
}

/// The version a save was made from, as the client read it. A save over any
/// other version is refused rather than overwriting it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct BasedOn<'a> {
    /// The modification time it was read at, in milliseconds; none to save
    /// over whatever is there.
    pub(crate) modified: Option<u64>,
    /// SHA-256 of the bytes it was read as, in lowercase hex (#245). The time
    /// cannot tell two versions apart on a disk that keeps it to the second
    /// (HFS+), to two (exFAT) or to the server's (SMB, NFS); the bytes can.
    pub(crate) digest: Option<&'a str>,
}

/// The shorthands tests save by; the command builds its `BasedOn` from what
/// the client sent.
#[cfg(test)]
impl BasedOn<'_> {
    /// No version to hold to: the save replaces whatever is there.
    pub(crate) const ANY: BasedOn<'static> = BasedOn {
        modified: None,
        digest: None,
    };

    /// The version read at `modified`, whatever its bytes.
    pub(crate) fn at(modified: u64) -> BasedOn<'static> {
        BasedOn {
            modified: Some(modified),
            digest: None,
        }
    }
}

/// Saves a note by writing a temporary file beside it and renaming over the top.
/// A rename within a directory is atomic, so an interrupted save can never leave a
/// half-written note: the reader sees either the old file or the new one.
///
/// The modification time is the version a save is checked against first, so
/// every save leaves one other than the version it replaced, even within the
/// same millisecond (see `write_temporary`). Another program's write on a disk
/// that keeps the time coarsely can leave it unchanged, so a save that names
/// the bytes it was read from is held to those too (`BasedOn::digest`).
///
/// A note that is a link out of the vault is refused by `resolve`; one that
/// is a link inside it has its target replaced, never the link's destination
/// written through.
fn write_text(root: &Path, path: &str, contents: &str, based_on: BasedOn) -> Result<u64, String> {
    let _turn = change_turn();
    let file = resolve(root, path)?;

    let metadata = fs::metadata(&file).map_err(|error| format!("cannot read: {error}"))?;
    if metadata.is_dir() {
        return Err("that is a directory".into());
    }
    let replaced = modified_ms(&metadata)?;
    if based_on
        .modified
        .is_some_and(|expected| expected != replaced)
    {
        return Err(CHANGED_ON_DISK.into());
    }
    if let Some(expected) = based_on.digest {
        refuse_other_bytes(&file, expected)?;
    }

    let temporary = temporary_beside(&file)?;

    let saved = write_temporary(&temporary, contents.as_bytes(), replaced)
        .map_err(|error| format!("cannot write: {error}"))
        .and_then(|modified| {
            fs::rename(&temporary, &file)
                .map(|()| modified)
                .map_err(|error| format!("cannot save: {error}"))
        });
    if saved.is_err() {
        let _ = fs::remove_file(&temporary); // Best effort; the save already failed.
    }
    saved
}

const CHANGED_ON_DISK: &str = "the note changed on disk since it was opened";

/// Whether the file at `relative` is still the version `read` names: its time,
/// and its bytes when a digest is given (#235). A file that is gone is not.
pub(crate) fn is_as_read(root: &Path, relative: &str, read: BasedOn) -> Result<bool, String> {
    match fs::symlink_metadata(resolve_new(root, relative)?) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("cannot read: {error}")),
        Ok(_) => {}
    }
    let file = resolve(root, relative)?;
    let metadata = fs::metadata(&file).map_err(|error| format!("cannot read: {error}"))?;
    let modified = modified_ms(&metadata)?;
    if read.modified.is_some_and(|expected| expected != modified) {
        return Ok(false);
    }
    match read
        .digest
        .map(|expected| refuse_other_bytes(&file, expected))
    {
        Some(Err(error)) if error == CHANGED_ON_DISK => Ok(false),
        Some(Err(error)) => Err(error),
        _ => Ok(true),
    }
}

/// Refuses a save when the note's bytes are not the ones it was read as.
///
/// Read only once the time has matched, so a stale save the time already
/// tells costs nothing more; one that matches costs a read and a SHA-256 of
/// the note, under the change turn (#245). Streamed, and held to no size
/// limit: a save may leave a note larger than a read takes, and the next
/// save over it must still be possible.
fn refuse_other_bytes(file: &Path, expected: &str) -> Result<(), String> {
    let mut handle = fs::File::open(file).map_err(|error| format!("cannot read: {error}"))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut handle, &mut hasher).map_err(|error| format!("cannot read: {error}"))?;
    if hex_of(&hasher.finalize()) != expected {
        return Err(CHANGED_ON_DISK.into());
    }
    Ok(())
}

/// SHA-256 of `bytes`, in lowercase hex: the digest a save names the version
/// it was read as by, which the app's adapter makes the same way.
#[cfg(test)]
fn digest_of(bytes: &[u8]) -> String {
    hex_of(&Sha256::digest(bytes))
}

fn hex_of(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Writes `bytes` to a new file at `temporary`, timed other than `after`
/// (the replaced version's time, in milliseconds since the epoch), and
/// reports that time.
///
/// The clock's own time is kept unless it is not past `after` by less than
/// `BUMP_GRACE_MS`: then the file is timed `after` + 1 ms. Within the grace,
/// saves stay in order even when several land in one millisecond, so no save
/// can come back to an earlier version's time. A note dated further ahead (an
/// unzip, `touch -t`) gets the clock's time back on its first save, rather
/// than staying in the future for good.
///
/// The `sync_all` costs some 4 ms a save on this Mac's SSD, spent while the
/// save holds the change turn.
///
/// A temporary left by a save that died is removed, never written through:
/// it could be a link planted to point anywhere. The new file is opened
/// exclusively and without following a link, so one planted in between is
/// refused rather than followed.
/// How far ahead of the clock a replaced version may be and still have a save
/// timed just after it. Bumps run ahead by a millisecond a save at most, and
/// a save takes several, so a second is far more than they ever reach.
const BUMP_GRACE_MS: u64 = 1000;

fn write_temporary(temporary: &Path, bytes: &[u8], after: u64) -> Result<u64, String> {
    match fs::remove_file(temporary) {
        Err(error) if error.kind() != ErrorKind::NotFound => {
            return Err(format!("cannot clear the way: {error}"));
        }
        _ => {}
    }
    let mut handle = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(temporary)
        .map_err(|error| error.to_string())?;
    handle.write_all(bytes).map_err(|error| error.to_string())?;
    let natural = modified_of(&handle)?;
    if natural <= after && after - natural < BUMP_GRACE_MS {
        handle
            .set_modified(UNIX_EPOCH + Duration::from_millis(after + 1))
            .map_err(|error| error.to_string())?;
    }
    handle.sync_all().map_err(|error| error.to_string())?;
    modified_of(&handle)
}

fn modified_of(handle: &fs::File) -> Result<u64, String> {
    modified_ms(&handle.metadata().map_err(|error| error.to_string())?)
}

/// A walk of the vault for markdown notes, and the two things that hold for all of it.
///
/// It reports what is on disk. Which of those notes the user should see is decided
/// in TypeScript (ADR-0014): the one thing this skips is the folders it was *told*
/// to skip, so a vault containing `node_modules` does not send tens of thousands of
/// paths across IPC for the frontend to throw away. It has no opinion about what a
/// name means — a dotted folder it was not told about is walked like any other.
struct NoteWalk<'a> {
    root: &'a Path,
    /// Names the frontend asked not to be descended into. Matched on the entry's
    /// own name at any level, which is how the rule that produced it is written.
    skip: &'a HashSet<String>,
    /// How many folders down to read notes, as the frontend's rule says: the
    /// archive refuses to file a note deeper than this, so the two must agree.
    /// A cap at all because a symlink can otherwise make the tree appear
    /// infinite even when every step stays inside the vault.
    max_depth: usize,
}

impl NoteWalk<'_> {
    /// Deliberately cheap per entry: names and paths only, never contents.
    fn collect(&self, directory: &Path, prefix: &str, depth: usize, notes: &mut Vec<VaultEntry>) {
        if depth > self.max_depth {
            return;
        }

        let Ok(entries) = fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if self.skip.contains(&name) {
                continue;
            }
            let Ok(metadata) = fs::metadata(entry.path()) else {
                continue;
            };
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };

            if metadata.is_dir() {
                // Refuse to follow a link that leaves the vault.
                if resolve(self.root, &relative).is_err() {
                    continue;
                }
                self.collect(&entry.path(), &relative, depth + 1, notes);
            } else if name.to_lowercase().ends_with(".md") {
                notes.push(VaultEntry {
                    name,
                    path: relative,
                    kind: "file",
                    modified: modified_ms(&metadata).unwrap_or(0),
                    size: metadata.len(),
                });
            }
        }
    }
}

/// Every markdown note on disk, for link resolution, autocomplete, the index and
/// backlinks — minus the folders `skip_directories` named, and no more than
/// `max_depth` folders down.
///
/// Off the main thread, as `read_notes` is: walking a large vault, and reading
/// it for the index, would otherwise freeze the window while they ran (#135).
#[tauri::command]
pub async fn list_notes(
    state: State<'_, VaultState>,
    skip_directories: Vec<String>,
    max_depth: usize,
) -> Result<Vec<VaultEntry>, String> {
    let root = root_of(&state)?;
    off_main(move || {
        let skip: HashSet<String> = skip_directories.into_iter().collect();
        let mut notes = Vec::new();
        NoteWalk {
            root: &root,
            skip: &skip,
            max_depth,
        }
        .collect(&root, "", 0, &mut notes);
        log::debug!("found {} notes", notes.len());
        Ok(notes)
    })
    .await
}

/// Runs work on the vault off the main thread, and off the async runtime's
/// workers, which every other async command and the local API server share.
/// Work that panicked or was cancelled answers as an error, never as nothing.
pub(crate) async fn off_main<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("the vault could not be reached: {error}"))?
}

/// Every change to the vault's files, one after another.
static CHANGES: Mutex<()> = Mutex::new(());

thread_local! {
    /// Whether this thread holds `CHANGES`, so a change made inside another
    /// (a command's vault check around the write it guards) takes no second turn.
    static HOLDS_CHANGES: Cell<bool> = const { Cell::new(false) };
}

/// This thread's turn to change the vault, held until dropped.
pub(crate) struct ChangeTurn(Option<MutexGuard<'static, ()>>);

impl Drop for ChangeTurn {
    fn drop(&mut self) {
        if self.0.is_some() {
            HOLDS_CHANGES.with(|holds| holds.set(false));
            #[cfg(test)]
            turn_watch::own(None);
        }
    }
}

/// Waits for this thread's turn to change the vault; at once when it already
/// has it. Every function that changes the vault's files takes it first.
///
/// The guarded value is nothing, so a change that panicked leaves nothing for
/// the poison flag to protect, and the next change still runs.
pub(crate) fn change_turn() -> ChangeTurn {
    if HOLDS_CHANGES.with(Cell::get) {
        return ChangeTurn(None);
    }
    #[cfg(test)]
    turn_watch::wait(true);
    let turn = CHANGES.lock().unwrap_or_else(PoisonError::into_inner);
    #[cfg(test)]
    {
        turn_watch::wait(false);
        turn_watch::own(Some(std::thread::current().id()));
    }
    HOLDS_CHANGES.with(|holds| holds.set(true));
    ChangeTurn(Some(turn))
}

/// Held, shared, by every read of a note, and alone by git while it rewrites
/// notes in place. A save lands by rename, so a read never waits behind one;
/// git unlinks a file and writes it anew, so a read during that would find
/// the note gone or part-written (#246).
static GIT_WRITING: RwLock<()> = RwLock::new(());

/// The turn git takes to rewrite notes: the change turn, so no save lands
/// meanwhile, then the notes to itself, so no read sees one half-written.
/// Fields drop in order: reads go on before the next change does.
pub(crate) struct GitWriteTurn {
    _writing: RwLockWriteGuard<'static, ()>,
    _turn: ChangeTurn,
}

/// Waits until git may rewrite notes. The guarded value is nothing, so a
/// poison flag protects nothing, as with `change_turn`.
pub(crate) fn git_write_turn() -> GitWriteTurn {
    let turn = change_turn();
    let writing = GIT_WRITING.write().unwrap_or_else(PoisonError::into_inner);
    GitWriteTurn {
        _writing: writing,
        _turn: turn,
    }
}

/// Waits while git rewrites notes; at once otherwise, however many read.
fn notes_whole() -> RwLockReadGuard<'static, ()> {
    #[cfg(test)]
    turn_watch::wait(true);
    let whole = GIT_WRITING.read().unwrap_or_else(PoisonError::into_inner);
    #[cfg(test)]
    turn_watch::wait(false);
    whole
}

/// The vault's own save and read, for tests outside this module, which
/// otherwise reach notes only through the commands.
#[cfg(test)]
pub(crate) mod test_access {
    use super::NoteContents;
    use std::path::Path;

    pub(crate) fn write_text(
        root: &Path,
        path: &str,
        contents: &str,
        based_on: super::BasedOn,
    ) -> Result<u64, String> {
        super::write_text(root, path, contents, based_on)
    }

    pub(crate) fn read_text(root: &Path, path: &str) -> Result<NoteContents, String> {
        super::read_text(root, path)
    }
}

/// Which thread holds the change turn, and which threads wait on it or on a
/// whole note: so a test can see who is where, whatever other tests run
/// beside it, without waiting on time.
#[cfg(test)]
pub(crate) mod turn_watch {
    use std::collections::HashSet;
    use std::sync::{Mutex, PoisonError};
    use std::thread::{self, ThreadId};

    static OWNER: Mutex<Option<ThreadId>> = Mutex::new(None);
    static WAITING: Mutex<Option<HashSet<ThreadId>>> = Mutex::new(None);

    pub(super) fn own(owner: Option<ThreadId>) {
        *OWNER.lock().unwrap_or_else(PoisonError::into_inner) = owner;
    }

    pub(super) fn wait(waiting: bool) {
        let id = thread::current().id();
        let mut set = WAITING.lock().unwrap_or_else(PoisonError::into_inner);
        let set = set.get_or_insert_with(HashSet::new);
        if waiting {
            set.insert(id);
        } else {
            set.remove(&id);
        }
    }

    /// The thread that holds the change turn now.
    pub(crate) fn owner() -> Option<ThreadId> {
        *OWNER.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether the thread is waiting for the change turn or for a whole note.
    pub(crate) fn is_waiting(id: ThreadId) -> bool {
        WAITING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .is_some_and(|set| set.contains(&id))
    }
}

/// Runs one change to the vault — a save, a creation, a move, a trash, a
/// binary write, a switch of vault — while no other is running.
///
/// On the main thread the host did one thing at a time; on the blocking pool
/// two saves of one note would both pass the modification check and race on
/// the one temporary file, and a save racing a move would rename its
/// temporary back to where the note had just left. Per path would not be
/// enough: moving a folder moves every path beneath it. Reads take no turn —
/// a save lands by rename, so a read sees the old file or the new one whole.
pub(crate) fn one_change_at_a_time<T>(change: impl FnOnce() -> T) -> T {
    let _turn = change_turn();
    change()
}

/// Runs `change` in the root of the vault it is meant for, refused when that
/// vault is no longer the open one by the time its turn comes: a switch takes
/// a turn too, so once it answers nothing more lands in the old vault.
pub(crate) fn change_in_vault<T>(
    state: &VaultState,
    meant_for: Option<&str>,
    change: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    one_change_at_a_time(|| change(&root_for_write(state.get(), meant_for)?))
}

#[tauri::command]
pub async fn list_directory(
    state: State<'_, VaultState>,
    path: String,
) -> Result<Vec<VaultEntry>, String> {
    let root = root_of(&state)?;
    off_main(move || {
        let entries = list_entries(&root, &path)?;
        log::debug!("listed {} entries in {:?}", entries.len(), path);
        Ok(entries)
    })
    .await
}

/// A note's text together with the facts the index needs about the file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    pub path: String,
    pub text: String,
    pub modified: u64,
    pub size: u64,
}

fn read_notes_at(root: &Path, paths: &[String]) -> Vec<NoteFile> {
    let _whole = notes_whole();
    let mut notes = Vec::with_capacity(paths.len());
    for path in paths {
        let Ok(file) = resolve(root, path) else {
            continue;
        };
        // A note that cannot be read as text is skipped, not fatal: one unreadable
        // file must not stop the rest of the vault being indexed.
        let Ok((bytes, metadata)) = read_one_version(&file, MAX_TEXT_BYTES) else {
            continue;
        };
        let size = bytes.len() as u64;
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        let Ok(modified) = modified_ms(&metadata) else {
            continue;
        };
        notes.push(NoteFile {
            path: path.clone(),
            text,
            modified,
            size,
        });
    }
    notes
}

/// Reads many notes in one call, so indexing a vault is not thousands of round trips.
#[tauri::command]
pub async fn read_notes(
    state: State<'_, VaultState>,
    paths: Vec<String>,
) -> Result<Vec<NoteFile>, String> {
    let root = root_of(&state)?;
    off_main(move || Ok(read_notes_at(&root, &paths))).await
}

#[tauri::command]
pub async fn read_text_file(
    state: State<'_, VaultState>,
    path: String,
) -> Result<NoteContents, String> {
    let root = root_of(&state)?;
    off_main(move || read_text(&root, &path)).await
}

/// Reads a file's bytes through one open handle, so the size checked is the
/// size of the file read even when a write replaces it meanwhile.
fn read_binary(root: &Path, path: &str) -> Result<Vec<u8>, String> {
    let _whole = notes_whole();
    read_one_version(&resolve(root, path)?, MAX_BINARY_BYTES).map(|(bytes, _)| bytes)
}

/// Raw bytes of a file in the vault, for showing an image.
///
/// Sent as a binary response rather than a JSON array, and read through the same
/// guard as everything else, so the webview never gets access to the filesystem.
#[tauri::command]
pub async fn read_binary_file(
    state: State<'_, VaultState>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let root = root_of(&state)?;
    let bytes = off_main(move || read_binary(&root, &path)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The vault check, the modification check and the write are one change: no
/// other change to the vault runs between them (see `one_change_at_a_time`).
#[tauri::command]
pub async fn write_text_file(
    app: AppHandle,
    path: String,
    contents: String,
    expected_modified: Option<u64>,
    expected_digest: Option<String>,
    vault: String,
) -> Result<u64, String> {
    off_main(move || {
        let based_on = BasedOn {
            modified: expected_modified,
            digest: expected_digest.as_deref(),
        };
        let modified = change_in_vault(&app.state::<VaultState>(), Some(&vault), |root| {
            write_text(root, &path, &contents, based_on)
        })?;
        log::info!("saved {path}");
        Ok(modified)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{resolve, resolve_new, root_for_write, VaultState};
    use std::fs;
    use std::path::PathBuf;
    use tempfile::tempdir;

    /// A thread that panics while holding the vault lock must not take the rest
    /// of the session with it: the guarded value is a single path, so there is
    /// nothing for the poison flag to protect.
    #[test]
    fn a_poisoned_lock_does_not_end_the_session() {
        use std::sync::Arc;

        let state = Arc::new(VaultState::default());
        *state.open() = Some(PathBuf::from("/tmp/atlas-vault"));

        let poisoner = Arc::clone(&state);
        let panicked = std::thread::spawn(move || {
            let _held = poisoner.0.lock().unwrap();
            panic!("a thread died holding the lock");
        })
        .join();
        assert!(panicked.is_err());

        // The path is still readable, and still writable.
        assert_eq!(state.get(), Some(PathBuf::from("/tmp/atlas-vault")));
        *state.open() = Some(PathBuf::from("/tmp/atlas-other"));
        assert_eq!(state.root(), Some(PathBuf::from("/tmp/atlas-other")));
    }

    #[test]
    fn writes_into_the_vault_the_write_was_meant_for() {
        let open = PathBuf::from("/vaults/a");
        assert_eq!(
            root_for_write(Some(open.clone()), Some("/vaults/a")),
            Ok(open)
        );
    }

    /// R14-01: a save that arrives after a switch must not land in the other
    /// vault's note of the same name.
    #[test]
    fn refuses_a_write_meant_for_a_vault_that_is_no_longer_open() {
        let refused = root_for_write(Some(PathBuf::from("/vaults/b")), Some("/vaults/a"));
        assert_eq!(
            refused,
            Err("another vault was opened before this could be written".to_string())
        );
    }

    /// R14-04: a write that does not say which vault it is meant for is not
    /// sent to whichever happens to be open; it is refused.
    #[test]
    fn refuses_a_write_that_names_no_vault() {
        assert_eq!(
            root_for_write(Some(PathBuf::from("/vaults/b")), None),
            Err("a write must name the vault it is meant for".to_string())
        );
    }

    #[test]
    fn refuses_a_write_when_no_vault_is_open() {
        assert_eq!(
            root_for_write(None, Some("/vaults/a")),
            Err("no vault is open".to_string())
        );
    }

    #[test]
    fn resolves_a_file_inside_the_vault() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("note.md"), "hi").unwrap();
        let resolved = resolve(vault.path(), "note.md").unwrap();
        assert!(resolved.ends_with("note.md"));
    }

    #[test]
    fn resolves_a_nested_file() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("Notes")).unwrap();
        fs::write(vault.path().join("Notes/today.md"), "hi").unwrap();
        assert!(resolve(vault.path(), "Notes/today.md").is_ok());
    }

    #[test]
    fn resolves_the_root_itself() {
        let vault = tempdir().unwrap();
        assert!(resolve(vault.path(), "").is_ok());
    }

    #[test]
    fn refuses_a_parent_escape() {
        let vault = tempdir().unwrap();
        assert!(resolve(vault.path(), "../secrets").is_err());
        assert!(resolve(vault.path(), "Notes/../../secrets").is_err());
    }

    #[test]
    fn refuses_an_absolute_path() {
        let vault = tempdir().unwrap();
        // A leading slash yields empty segments, so this can only ever resolve
        // relative to the vault — never to the real /etc.
        assert!(resolve(vault.path(), "/etc/passwd").is_err());
    }

    #[test]
    fn refuses_a_null_byte() {
        let vault = tempdir().unwrap();
        assert!(resolve(vault.path(), "note.md\0.png").is_err());
    }

    #[test]
    fn refuses_a_symlink_pointing_outside_the_vault() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secrets.txt"), "top secret").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secrets.txt"),
            vault.path().join("link"),
        )
        .unwrap();

        let error = resolve(vault.path(), "link").unwrap_err();
        assert_eq!(error, "path escapes the vault");
    }

    #[test]
    fn allows_a_symlink_pointing_inside_the_vault() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("real.md"), "hi").unwrap();
        std::os::unix::fs::symlink(vault.path().join("real.md"), vault.path().join("alias.md"))
            .unwrap();
        assert!(resolve(vault.path(), "alias.md").is_ok());
    }

    #[test]
    fn reports_a_missing_entry_rather_than_guessing() {
        let vault = tempdir().unwrap();
        assert!(resolve(vault.path(), "nope.md").is_err());
    }

    /// A vault with `.atlas/settings.md` and `.git/config`, and user-space
    /// links into both: what a synced folder or a stray `ln -s` can leave.
    fn vault_with_links_into_hidden_folders() -> tempfile::TempDir {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join(".atlas")).unwrap();
        fs::create_dir(vault.path().join(".git")).unwrap();
        fs::create_dir(vault.path().join("Notes")).unwrap();
        fs::write(vault.path().join(".atlas/settings.md"), "mine").unwrap();
        fs::write(vault.path().join(".git/config"), "[core]").unwrap();
        let link = |target: &str, at: &str| {
            std::os::unix::fs::symlink(vault.path().join(target), vault.path().join(at)).unwrap()
        };
        link(".atlas/settings.md", "Notes/settings.md");
        link(".atlas", "Notes/system");
        link(".git/config", "config.md");
        vault
    }

    #[test]
    fn refuses_a_link_that_leads_into_a_hidden_folder_the_path_did_not_name() {
        let vault = vault_with_links_into_hidden_folders();
        let refused = "path reaches a hidden folder through a link".to_string();

        assert_eq!(
            resolve(vault.path(), "Notes/settings.md"),
            Err(refused.clone())
        );
        assert_eq!(resolve(vault.path(), "config.md"), Err(refused.clone()));
        assert_eq!(
            resolve(vault.path(), "Notes/system/settings.md"),
            Err(refused.clone())
        );
        assert_eq!(
            resolve_new(vault.path(), "Notes/system/new.md"),
            Err(refused)
        );
    }

    #[test]
    fn still_reaches_a_hidden_folder_by_its_own_name() {
        let vault = vault_with_links_into_hidden_folders();
        assert!(resolve(vault.path(), ".atlas/settings.md").is_ok());
        assert!(resolve_new(vault.path(), ".atlas/new.md").is_ok());
    }

    /// DFAI runs `git` in the vault (U-29): a `.git/config` or `.git` file the
    /// webview could write would be a program git runs. Named or reached, in
    /// any case, for reads and writes alike, it is refused.
    #[test]
    fn never_reaches_gits_own_folder() {
        let vault = vault_with_links_into_hidden_folders();
        fs::create_dir(vault.path().join("Sub")).unwrap();
        let refused = Err("git's own folder is not part of the vault".to_string());

        assert_eq!(resolve(vault.path(), ".git/config"), refused);
        assert_eq!(resolve(vault.path(), ".GIT/config"), refused);
        assert_eq!(resolve_new(vault.path(), ".git/hooks-new"), refused);
        assert_eq!(resolve_new(vault.path(), ".git"), refused);
        assert_eq!(resolve_new(vault.path(), "Sub/.Git"), refused);
        assert_eq!(resolve(vault.path(), "Sub/../.git/config"), refused);
        assert!(super::create_note_at(vault.path(), ".git/config", "[core]").is_err());
        assert_eq!(
            fs::read_to_string(vault.path().join(".git/config")).unwrap(),
            "[core]"
        );
    }

    #[test]
    fn a_link_that_lands_in_gits_folder_is_refused() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join(".git")).unwrap();
        std::os::unix::fs::symlink(vault.path().join(".git"), vault.path().join(".repo")).unwrap();
        assert!(resolve_new(vault.path(), ".repo/config").is_err());
        assert!(resolve(vault.path(), ".repo").is_err());
    }

    #[test]
    fn the_gitignore_at_the_top_stays_writable() {
        let vault = tempdir().unwrap();
        assert!(resolve_new(vault.path(), ".gitignore").is_ok());
        assert!(resolve_new(vault.path(), ".gitattributes").is_ok());
    }

    /// The TypeScript side keeps the API out of any hidden folder, however deep
    /// (`isUserSpace`); a link in user space must not reach one below the top
    /// that the path did not name — a tag rename writes whatever note it finds.
    #[test]
    fn refuses_a_link_into_a_hidden_folder_below_the_top_of_the_vault() {
        let vault = tempdir().unwrap();
        fs::create_dir_all(vault.path().join("Projects/.obsidian")).unwrap();
        fs::create_dir(vault.path().join("Notes")).unwrap();
        fs::write(vault.path().join("Projects/.obsidian/app.md"), "#idea").unwrap();
        std::os::unix::fs::symlink(
            vault.path().join("Projects/.obsidian/app.md"),
            vault.path().join("Notes/app.md"),
        )
        .unwrap();

        assert_eq!(
            resolve(vault.path(), "Notes/app.md"),
            Err("path reaches a hidden folder through a link".to_string())
        );
    }
}

#[cfg(test)]
mod read_tests {
    use super::{list_entries, read_text};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn lists_files_and_directories_with_their_kind() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("Notes")).unwrap();
        fs::write(vault.path().join("todo.md"), "x").unwrap();

        let mut entries = list_entries(vault.path(), "").unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "Notes");
        assert_eq!(entries[0].kind, "directory");
        assert_eq!(entries[1].name, "todo.md");
        assert_eq!(entries[1].kind, "file");
    }

    #[test]
    fn builds_child_paths_relative_to_the_vault() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("Notes")).unwrap();
        fs::write(vault.path().join("Notes/today.md"), "x").unwrap();

        let entries = list_entries(vault.path(), "Notes").unwrap();
        assert_eq!(entries[0].path, "Notes/today.md");
    }

    #[test]
    fn lists_an_empty_directory_as_empty() {
        let vault = tempdir().unwrap();
        assert!(list_entries(vault.path(), "").unwrap().is_empty());
    }

    #[test]
    fn skips_a_broken_symlink_rather_than_failing_the_listing() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("real.md"), "x").unwrap();
        std::os::unix::fs::symlink(vault.path().join("gone.md"), vault.path().join("broken"))
            .unwrap();

        let entries = list_entries(vault.path(), "").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "real.md");
    }

    #[test]
    fn lists_a_symlinked_folder_as_a_folder() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("Real")).unwrap();
        std::os::unix::fs::symlink(vault.path().join("Real"), vault.path().join("Alias")).unwrap();

        let entries = list_entries(vault.path(), "").unwrap();
        let alias = entries.iter().find(|e| e.name == "Alias").unwrap();
        assert_eq!(alias.kind, "directory");
    }

    #[test]
    fn refuses_to_list_outside_the_vault() {
        let vault = tempdir().unwrap();
        assert!(list_entries(vault.path(), "../..").is_err());
    }

    #[test]
    fn reads_a_note_byte_for_byte() {
        let vault = tempdir().unwrap();
        let text = "---\ntitle: Today\n---\n\n# Today\n\n- [ ] one\n";
        fs::write(vault.path().join("today.md"), text).unwrap();
        assert_eq!(read_text(vault.path(), "today.md").unwrap().text, text);
    }

    #[test]
    fn reads_utf8_beyond_ascii() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "año — 日本語\n").unwrap();
        assert_eq!(
            read_text(vault.path(), "a.md").unwrap().text,
            "año — 日本語\n"
        );
    }

    #[test]
    fn refuses_to_read_a_directory_as_text() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("Notes")).unwrap();
        assert_eq!(
            read_text(vault.path(), "Notes").unwrap_err(),
            "that is a directory"
        );
    }

    #[test]
    fn refuses_a_file_that_is_not_text() {
        let vault = tempdir().unwrap();
        fs::write(
            vault.path().join("photo.png"),
            [0xff, 0xd8, 0xff, 0x00, 0x80],
        )
        .unwrap();
        assert_eq!(
            read_text(vault.path(), "photo.png").unwrap_err(),
            "not a text file"
        );
    }

    #[test]
    fn refuses_a_file_over_the_size_limit() {
        let vault = tempdir().unwrap();
        let big = vec![b'a'; (super::MAX_TEXT_BYTES + 1) as usize];
        fs::write(vault.path().join("big.md"), big).unwrap();
        assert!(read_text(vault.path(), "big.md")
            .unwrap_err()
            .contains("larger than"));
    }
}

#[cfg(test)]
mod write_tests {
    use super::{read_text, write_text, BasedOn};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn saves_the_exact_bytes_it_was_given() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "old\n").unwrap();

        let text = "---\ntitle: New\n---\n\n# New\n\n- [ ] one\n";
        write_text(vault.path(), "a.md", text, BasedOn::ANY).unwrap();
        assert_eq!(fs::read_to_string(vault.path().join("a.md")).unwrap(), text);
    }

    #[test]
    fn leaves_no_temporary_file_behind() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "old\n").unwrap();
        write_text(vault.path(), "a.md", "new\n", BasedOn::ANY).unwrap();

        let names: Vec<_> = fs::read_dir(vault.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["a.md"]);
    }

    #[test]
    fn reports_a_new_modification_time() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "old\n").unwrap();

        let before = read_text(vault.path(), "a.md").unwrap().modified;
        let after = write_text(vault.path(), "a.md", "new\n", BasedOn::ANY).unwrap();
        assert!(after >= before);
        assert_eq!(read_text(vault.path(), "a.md").unwrap().modified, after);
    }

    #[test]
    fn saves_when_the_file_is_untouched_since_it_was_read() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "old\n").unwrap();

        let opened = read_text(vault.path(), "a.md").unwrap();
        assert!(write_text(vault.path(), "a.md", "new\n", BasedOn::at(opened.modified)).is_ok());
    }

    #[test]
    fn refuses_to_clobber_a_note_edited_elsewhere() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "old\n").unwrap();
        let opened = read_text(vault.path(), "a.md").unwrap();

        // Something else — Obsidian, a sync client — rewrites the file.
        let error = write_text(
            vault.path(),
            "a.md",
            "mine\n",
            BasedOn::at(opened.modified - 1),
        )
        .unwrap_err();
        assert_eq!(error, "the note changed on disk since it was opened");
        assert_eq!(
            fs::read_to_string(vault.path().join("a.md")).unwrap(),
            "old\n"
        );
    }

    #[test]
    fn refuses_to_write_outside_the_vault() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secrets.txt"), "top secret").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secrets.txt"),
            vault.path().join("link"),
        )
        .unwrap();

        assert!(write_text(vault.path(), "link", "hacked", BasedOn::ANY).is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("secrets.txt")).unwrap(),
            "top secret"
        );
    }

    #[test]
    fn refuses_to_write_over_a_directory() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("Notes")).unwrap();
        assert_eq!(
            write_text(vault.path(), "Notes", "x", BasedOn::ANY).unwrap_err(),
            "that is a directory"
        );
    }

    #[test]
    fn round_trips_unicode_and_windows_line_endings() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "x").unwrap();
        let text = "año — 日本語 🎉\r\nsecond\r\n";
        write_text(vault.path(), "a.md", text, BasedOn::ANY).unwrap();
        assert_eq!(read_text(vault.path(), "a.md").unwrap().text, text);
    }
}

#[cfg(test)]
mod note_tests {
    use super::{NoteWalk, VaultEntry};
    use std::collections::HashSet;
    use std::fs;
    use tempfile::tempdir;

    /// The walk with nothing skipped: everything on disk, which is the contract.
    fn notes_in(root: &std::path::Path) -> Vec<String> {
        skipping(root, &[])
    }

    fn skipping(root: &std::path::Path, skip: &[&str]) -> Vec<String> {
        let skip: HashSet<String> = skip.iter().map(|name| (*name).to_owned()).collect();
        let mut notes: Vec<VaultEntry> = Vec::new();
        // The depth the frontend hands over (VAULT_WALK_DEPTH).
        NoteWalk {
            root,
            skip: &skip,
            max_depth: 32,
        }
        .collect(root, "", 0, &mut notes);
        let mut paths: Vec<String> = notes.into_iter().map(|note| note.path).collect();
        paths.sort();
        paths
    }

    #[test]
    fn finds_notes_at_every_level() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("top.md"), "x").unwrap();
        fs::create_dir_all(vault.path().join("a/b")).unwrap();
        fs::write(vault.path().join("a/mid.md"), "x").unwrap();
        fs::write(vault.path().join("a/b/deep.md"), "x").unwrap();

        assert_eq!(
            notes_in(vault.path()),
            vec!["a/b/deep.md", "a/mid.md", "top.md"]
        );
    }

    #[test]
    fn ignores_files_that_are_not_markdown() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("note.md"), "x").unwrap();
        fs::write(vault.path().join("photo.png"), "x").unwrap();
        fs::write(vault.path().join("data.json"), "x").unwrap();

        assert_eq!(notes_in(vault.path()), vec!["note.md"]);
    }

    #[test]
    fn accepts_an_uppercase_extension() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("Note.MD"), "x").unwrap();
        assert_eq!(notes_in(vault.path()), vec!["Note.MD"]);
    }

    #[test]
    fn reports_a_dotted_directory_it_was_not_told_to_skip() {
        // The point of A13-09: deciding that a dot means hidden is the frontend's
        // job, and this walk no longer has an opinion about it.
        let vault = tempdir().unwrap();
        fs::create_dir_all(vault.path().join(".atlas/types")).unwrap();
        fs::write(vault.path().join(".atlas/types/task.md"), "x").unwrap();
        fs::create_dir(vault.path().join(".obsidian")).unwrap();
        fs::write(vault.path().join(".obsidian/config.md"), "x").unwrap();
        fs::write(vault.path().join("keep.md"), "x").unwrap();

        assert_eq!(
            notes_in(vault.path()),
            vec![".atlas/types/task.md", ".obsidian/config.md", "keep.md"]
        );
    }

    #[test]
    fn does_not_descend_into_a_directory_it_was_told_to_skip() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join(".obsidian")).unwrap();
        fs::write(vault.path().join(".obsidian/config.md"), "x").unwrap();
        fs::create_dir(vault.path().join("node_modules")).unwrap();
        fs::write(vault.path().join("node_modules/readme.md"), "x").unwrap();
        fs::write(vault.path().join("keep.md"), "x").unwrap();

        assert_eq!(
            skipping(vault.path(), &[".obsidian", "node_modules"]),
            vec!["keep.md"]
        );
    }

    #[test]
    fn skips_a_named_directory_wherever_it_sits() {
        let vault = tempdir().unwrap();
        fs::create_dir_all(vault.path().join("Projects/app/node_modules/pkg")).unwrap();
        fs::write(
            vault.path().join("Projects/app/node_modules/pkg/readme.md"),
            "x",
        )
        .unwrap();
        fs::write(vault.path().join("Projects/app/notes.md"), "x").unwrap();

        assert_eq!(
            skipping(vault.path(), &["node_modules"]),
            vec!["Projects/app/notes.md"]
        );
    }

    #[test]
    fn skips_a_file_with_a_skipped_name_as_well_as_a_directory() {
        // The rule this list comes from matches any path segment, a file's own
        // name included, so the walk matches on the name and not on the kind.
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("node_modules"), "not a folder").unwrap();
        fs::write(vault.path().join("keep.md"), "x").unwrap();

        assert_eq!(skipping(vault.path(), &["node_modules"]), vec!["keep.md"]);
    }

    #[test]
    fn a_skipped_name_does_not_match_a_longer_one() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join(".gitlab")).unwrap();
        fs::write(vault.path().join(".gitlab/ci.md"), "x").unwrap();

        assert_eq!(skipping(vault.path(), &[".git"]), vec![".gitlab/ci.md"]);
    }

    #[test]
    fn does_not_follow_a_directory_link_out_of_the_vault() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path(), vault.path().join("escape")).unwrap();
        fs::write(vault.path().join("inside.md"), "x").unwrap();

        assert_eq!(notes_in(vault.path()), vec!["inside.md"]);
    }

    #[test]
    fn does_not_follow_a_dotted_directory_link_out_of_the_vault() {
        // Dotted folders used to be skipped outright, so the containment check
        // was never what stopped this one. Now it is the only thing that does.
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path(), vault.path().join(".escape")).unwrap();
        fs::write(vault.path().join("inside.md"), "x").unwrap();

        assert_eq!(notes_in(vault.path()), vec!["inside.md"]);
    }

    #[test]
    fn stops_descending_at_the_depth_cap() {
        let vault = tempdir().unwrap();
        let deep: std::path::PathBuf = (0..40).map(|level| format!("d{level}")).collect();
        fs::create_dir_all(vault.path().join(&deep)).unwrap();
        fs::write(vault.path().join(&deep).join("buried.md"), "x").unwrap();
        fs::write(vault.path().join("d0/shallow.md"), "x").unwrap();

        let found = notes_in(vault.path());
        assert!(found.contains(&"d0/shallow.md".to_owned()));
        assert!(found.iter().all(|path| !path.ends_with("buried.md")));
    }

    /// The depth is the frontend's rule, handed over like the skip list (ADR-0014):
    /// a note `max_depth` folders down is read, one folder further is not.
    #[test]
    fn reads_exactly_as_deep_as_it_is_told() {
        let vault = tempdir().unwrap();
        fs::create_dir_all(vault.path().join("a/b/c")).unwrap();
        fs::write(vault.path().join("a/b/at-two.md"), "x").unwrap();
        fs::write(vault.path().join("a/b/c/at-three.md"), "x").unwrap();

        let skip = HashSet::new();
        let mut notes: Vec<VaultEntry> = Vec::new();
        NoteWalk {
            root: vault.path(),
            skip: &skip,
            max_depth: 2,
        }
        .collect(vault.path(), "", 0, &mut notes);
        let paths: Vec<String> = notes.into_iter().map(|note| note.path).collect();
        assert_eq!(paths, vec!["a/b/at-two.md"]);
    }

    #[test]
    fn handles_an_empty_vault() {
        let vault = tempdir().unwrap();
        assert!(notes_in(vault.path()).is_empty());
    }
}

#[cfg(test)]
mod binary_tests {
    use super::read_binary;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn reads_the_exact_bytes() {
        let vault = tempdir().unwrap();
        let bytes: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x00, 0xff];
        fs::write(vault.path().join("pic.png"), &bytes).unwrap();
        assert_eq!(read_binary(vault.path(), "pic.png").unwrap(), bytes);
    }

    #[test]
    fn refuses_a_directory() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("images")).unwrap();
        assert_eq!(
            read_binary(vault.path(), "images").unwrap_err(),
            "that is a directory"
        );
    }

    #[test]
    fn refuses_a_file_outside_the_vault() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.png"), [1, 2, 3]).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.png"),
            vault.path().join("link.png"),
        )
        .unwrap();
        assert!(read_binary(vault.path(), "link.png").is_err());
    }

    #[test]
    fn reports_a_missing_file() {
        let vault = tempdir().unwrap();
        assert!(read_binary(vault.path(), "nope.png").is_err());
    }
}

#[cfg(test)]
mod batch_tests {
    use super::read_notes_at;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn reads_several_notes_in_one_call() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "alpha").unwrap();
        fs::write(vault.path().join("b.md"), "beta").unwrap();

        let notes = read_notes_at(vault.path(), &["a.md".into(), "b.md".into()]);
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].text, "alpha");
        assert_eq!(notes[1].size, 4);
    }

    #[test]
    fn skips_a_note_that_is_missing_rather_than_failing_the_batch() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "alpha").unwrap();

        let notes = read_notes_at(vault.path(), &["gone.md".into(), "a.md".into()]);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].path, "a.md");
    }

    #[test]
    fn skips_a_file_that_is_not_text() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("pic.png"), [0xff, 0xd8, 0x80]).unwrap();
        assert!(read_notes_at(vault.path(), &["pic.png".into()]).is_empty());
    }

    #[test]
    fn refuses_a_path_outside_the_vault() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "secret").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.md"),
            vault.path().join("link.md"),
        )
        .unwrap();

        assert!(read_notes_at(vault.path(), &["link.md".into()]).is_empty());
    }

    #[test]
    fn an_empty_request_reads_nothing() {
        let vault = tempdir().unwrap();
        assert!(read_notes_at(vault.path(), &[]).is_empty());
    }
}

#[cfg(test)]
mod create_tests {
    use super::{create_note_at, read_text, write_text, BasedOn};
    use std::fs;
    use tempfile::tempdir;

    /// #258: the time reported is the new note's own, as a read of it finds,
    /// so the app can know the watcher's report of it as its own write.
    #[test]
    fn reports_the_time_the_new_note_was_left_at() {
        let vault = tempdir().unwrap();
        let modified = create_note_at(vault.path(), "Untitled.md", "# Untitled\n").unwrap();
        assert_eq!(
            read_text(vault.path(), "Untitled.md").unwrap().modified,
            modified
        );
    }

    /// The reported time is the version a first save is checked against, as a
    /// save's own reported time is: one the note was not at is refused.
    #[test]
    fn a_save_checked_against_the_reported_time_lands() {
        let vault = tempdir().unwrap();
        let modified = create_note_at(vault.path(), "a.md", "first").unwrap();
        assert!(write_text(vault.path(), "a.md", "second", BasedOn::at(modified + 1)).is_err());
        write_text(vault.path(), "a.md", "second", BasedOn::at(modified)).unwrap();
        assert_eq!(read_text(vault.path(), "a.md").unwrap().text, "second");
    }

    #[test]
    fn creates_a_note_with_the_given_contents() {
        let vault = tempdir().unwrap();
        create_note_at(vault.path(), "Untitled.md", "# Untitled\n\n").unwrap();
        assert_eq!(
            read_text(vault.path(), "Untitled.md").unwrap().text,
            "# Untitled\n\n"
        );
    }

    #[test]
    fn creates_a_note_inside_a_folder() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("Notes")).unwrap();
        create_note_at(vault.path(), "Notes/Today.md", "x").unwrap();
        assert!(vault.path().join("Notes/Today.md").is_file());
    }

    #[test]
    fn refuses_to_overwrite_an_existing_note() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "original").unwrap();

        let error = create_note_at(vault.path(), "a.md", "replacement").unwrap_err();
        assert_eq!(error, "a note with that name already exists");
        assert_eq!(
            fs::read_to_string(vault.path().join("a.md")).unwrap(),
            "original"
        );
    }

    #[test]
    fn refuses_a_folder_that_does_not_exist() {
        let vault = tempdir().unwrap();
        assert_eq!(
            create_note_at(vault.path(), "Nowhere/a.md", "x").unwrap_err(),
            "that folder does not exist"
        );
    }

    #[test]
    fn refuses_a_path_that_climbs_out_of_the_vault() {
        let vault = tempdir().unwrap();
        assert!(create_note_at(vault.path(), "../escaped.md", "x").is_err());
        assert!(!vault.path().parent().unwrap().join("escaped.md").exists());
    }

    #[test]
    fn refuses_to_create_through_a_folder_link_leaving_the_vault() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), vault.path().join("escape")).unwrap();

        assert_eq!(
            create_note_at(vault.path(), "escape/a.md", "x").unwrap_err(),
            "path escapes the vault"
        );
        assert!(!outside.path().join("a.md").exists());
    }

    #[test]
    fn refuses_a_name_that_is_only_a_folder() {
        let vault = tempdir().unwrap();
        assert!(create_note_at(vault.path(), "", "x").is_err());
    }

    #[test]
    fn refuses_a_null_byte() {
        let vault = tempdir().unwrap();
        assert!(create_note_at(vault.path(), "a\0.md", "x").is_err());
    }
}

/// The vault's commands run on the blocking pool, several at once: these hold
/// that a save is still one change, checked and written with nothing between.
/// They call the write functions bare, as the commands do, so a write that
/// stopped taking its turn would fail them.
#[cfg(test)]
mod concurrency_tests {
    use super::{one_change_at_a_time, read_text, write_text, BasedOn};
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{Duration, UNIX_EPOCH};
    use tempfile::tempdir;

    const SAVERS: usize = 8;
    const ROUNDS: usize = 25;

    /// A note last written long ago, so that any save gives it a new time.
    fn old_note(vault: &Path, text: &str) -> u64 {
        let file = vault.join("a.md");
        fs::write(&file, text).unwrap();
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_secs(1_000_000))
            .unwrap();
        read_text(vault, "a.md").unwrap().modified
    }

    /// Saves `a.md` from `SAVERS` threads released together, as the command does.
    fn save_together(root: &Path, expected: Option<u64>) -> Vec<Result<u64, String>> {
        let start = Arc::new(Barrier::new(SAVERS));
        let savers: Vec<_> = (0..SAVERS)
            .map(|saver| {
                let start = Arc::clone(&start);
                let root: PathBuf = root.to_path_buf();
                thread::spawn(move || {
                    start.wait();
                    write_text(
                        &root,
                        "a.md",
                        &format!("saver {saver}"),
                        BasedOn {
                            modified: expected,
                            ..BasedOn::ANY
                        },
                    )
                })
            })
            .collect();
        savers
            .into_iter()
            .map(|saver| saver.join().unwrap())
            .collect()
    }

    #[test]
    fn of_saves_opened_at_one_version_only_the_first_lands_and_the_rest_are_refused_as_stale() {
        for round in 0..ROUNDS {
            let vault = tempdir().unwrap();
            let opened = old_note(vault.path(), "first");
            let results = save_together(vault.path(), Some(opened));
            let landed = results.iter().filter(|result| result.is_ok()).count();
            assert_eq!(landed, 1, "round {round}: {results:?}");
            for result in results.iter().filter(|result| result.is_err()) {
                assert_eq!(
                    result,
                    &Err("the note changed on disk since it was opened".to_string()),
                    "round {round}"
                );
            }
            let text = fs::read_to_string(vault.path().join("a.md")).unwrap();
            assert!(text.starts_with("saver "), "round {round}: {text:?}");
        }
    }

    #[test]
    fn saves_of_one_note_at_once_each_land_whole_and_leave_no_temporary_behind() {
        for round in 0..ROUNDS {
            let vault = tempdir().unwrap();
            old_note(vault.path(), "first");
            let results = save_together(vault.path(), None);
            assert!(
                results.iter().all(Result::is_ok),
                "round {round}: {results:?}"
            );
            let text = fs::read_to_string(vault.path().join("a.md")).unwrap();
            let whole = (0..SAVERS).any(|saver| text == format!("saver {saver}"));
            assert!(whole, "round {round}: {text:?}");
            assert!(
                !vault.path().join(".a.md.atlas-tmp").exists(),
                "round {round}"
            );
        }
    }

    /// A read pairs a text with the time of that same version, whatever save
    /// lands while it runs: the wrong time would make the next save look stale,
    /// or let it write over a newer note.
    #[test]
    fn a_read_during_saves_answers_one_version_and_that_versions_time() {
        let vault = tempdir().unwrap();
        let first = old_note(vault.path(), "version 0");
        let root = vault.path().to_path_buf();
        let saver = thread::spawn(move || {
            let mut written = HashMap::from([("version 0".to_string(), first)]);
            for version in 1..400 {
                // Lengths differ, so a torn read could not pass for a version.
                let text = format!("version {version} {}", "x".repeat(version));
                let modified = write_text(&root, "a.md", &text, BasedOn::ANY);
                written.insert(text, modified.unwrap());
            }
            written
        });
        let mut reads = Vec::new();
        while !saver.is_finished() {
            reads.push(read_text(vault.path(), "a.md").unwrap());
        }
        let written = saver.join().unwrap();
        assert!(!reads.is_empty());
        for read in reads {
            assert_eq!(
                written.get(&read.text),
                Some(&read.modified),
                "{:?} read with another version's time",
                read.text
            );
        }
    }

    /// A note is never seen half-made: a read racing its creation finds no
    /// note or the whole of it, never an empty file the text is still being
    /// written into.
    #[test]
    fn a_read_racing_a_creation_never_sees_an_empty_note() {
        let vault = tempdir().unwrap();
        let root = vault.path().to_path_buf();
        let creator = thread::spawn(move || {
            for _ in 0..500 {
                super::create_note_at(&root, "n.md", "made whole").unwrap();
                one_change_at_a_time(|| fs::remove_file(root.join("n.md")).unwrap());
            }
        });
        let mut seen = Vec::new();
        while !creator.is_finished() {
            if let Ok(read) = read_text(vault.path(), "n.md") {
                seen.push(read.text);
            }
        }
        creator.join().unwrap();
        let torn: Vec<_> = seen.iter().filter(|text| *text != "made whole").collect();
        assert!(
            torn.is_empty(),
            "{} of {} reads torn: {:?}",
            torn.len(),
            seen.len(),
            torn.first()
        );
    }

    /// A save racing a move must not rename its temporary back to where the
    /// note just left: the note would be in two places, the moved copy stale.
    #[test]
    fn a_save_racing_a_move_never_puts_the_note_back_where_it_was() {
        for round in 0..ROUNDS {
            let vault = tempdir().unwrap();
            fs::create_dir(vault.path().join("Notes")).unwrap();
            fs::create_dir(vault.path().join("Archive")).unwrap();
            fs::write(vault.path().join("Notes/a.md"), "first").unwrap();
            let start = Arc::new(Barrier::new(2));
            let moved = Arc::new(AtomicBool::new(false));
            let root = vault.path().to_path_buf();
            let saver = {
                let (start, moved, root) = (Arc::clone(&start), Arc::clone(&moved), root.clone());
                thread::spawn(move || {
                    start.wait();
                    // Bounded: the lock is not fair, and the move may well
                    // only get its turn once the saves are done.
                    for _ in 0..40 {
                        if moved.load(Ordering::SeqCst)
                            || write_text(&root, "Notes/a.md", "saved", BasedOn::ANY).is_err()
                        {
                            break;
                        }
                    }
                })
            };
            start.wait();
            crate::vault_entries::move_entry_at(&root, "Notes/a.md", "Archive/a.md").unwrap();
            moved.store(true, Ordering::SeqCst);
            saver.join().unwrap();
            assert!(!root.join("Notes/a.md").exists(), "round {round}");
            assert!(root.join("Archive/a.md").exists(), "round {round}");
            assert!(
                !root.join("Notes/.a.md.atlas-tmp").exists(),
                "round {round}"
            );
        }
    }
}

/// Adversarial probes of the vault's changes running on the blocking pool
/// (PR #242). Each test names the invariant it holds.
#[cfg(test)]
mod attack_242_tests {
    use super::{list_entries, one_change_at_a_time, read_text, write_text, BasedOn};
    use crate::vault_entries::{create_folder_at, move_entry_at, trash_entry_at};
    use crate::vault_files::replace_binary_at;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;
    use tempfile::tempdir;

    /// A small seeded generator, so a failing schedule can be replayed.
    struct XorShift(u64);
    impl XorShift {
        fn below(&mut self, bound: u64) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % bound
        }
    }

    /// The modification time is the only version a save is checked against,
    /// so two different versions must never share one. A note created and
    /// saved in the same millisecond does, and a writer still holding the
    /// first version's time then saves over the second.
    #[test]
    fn a_save_holding_an_older_versions_time_is_refused_even_within_one_millisecond() {
        for round in 0..200 {
            let vault = tempdir().unwrap();
            fs::write(vault.path().join("a.md"), "opened by both").unwrap();
            let opened = read_text(vault.path(), "a.md").unwrap().modified;
            // Pane one saves first, from the version both opened.
            one_change_at_a_time(|| {
                write_text(vault.path(), "a.md", "pane one", BasedOn::at(opened))
            })
            .unwrap();
            // Pane two still holds the version it opened; its save is stale.
            let stale = one_change_at_a_time(|| {
                write_text(vault.path(), "a.md", "pane two", BasedOn::at(opened))
            });
            assert!(
                stale.is_err(),
                "round {round}: a stale save was accepted and \"pane one\" was lost"
            );
            assert_eq!(
                fs::read_to_string(vault.path().join("a.md")).unwrap(),
                "pane one",
                "round {round}"
            );
        }
    }

    /// A save writes only the note it names. A link left at the note's
    /// temporary name (by anything that can write the vault: sync, an
    /// archive, another app) must not carry the save's text out of it.
    #[test]
    fn a_save_never_writes_through_a_link_at_its_temporary_name() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let victim = outside.path().join("victim.txt");
        fs::write(&victim, "not the vault's").unwrap();
        fs::write(vault.path().join("a.md"), "note").unwrap();
        std::os::unix::fs::symlink(&victim, vault.path().join(".a.md.atlas-tmp")).unwrap();

        let saved =
            one_change_at_a_time(|| write_text(vault.path(), "a.md", "saved text", BasedOn::ANY));

        assert_eq!(
            fs::read_to_string(&victim).unwrap(),
            "not the vault's",
            "the save wrote outside the vault (result {saved:?})"
        );
    }

    /// The lock guards nothing, so a change that panics must not stop the
    /// next one from running.
    #[test]
    fn a_change_that_panicked_inside_the_lock_does_not_stop_later_saves() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "first").unwrap();
        let panicked = thread::spawn(|| one_change_at_a_time(|| panic!("a change blew up"))).join();
        assert!(panicked.is_err());

        let (done, finished) = mpsc::channel();
        let root = vault.path().to_path_buf();
        thread::spawn(move || {
            done.send(one_change_at_a_time(|| {
                write_text(&root, "a.md", "after", BasedOn::ANY)
            }))
            .unwrap();
        });
        let result = finished
            .recv_timeout(Duration::from_secs(10))
            .expect("the save after a panic never got its turn");
        assert!(result.is_ok(), "{result:?}");
    }

    const NOTES: [&str; 3] = ["F/a.md", "F/b.md", "G/c.md"];

    /// A note's text as written by one save: whole only if both ends match.
    fn stamped(thread: usize, step: usize, filler: usize) -> String {
        let id = format!("{thread}-{step}");
        format!("BEGIN {id} {} END {id}", "x".repeat(filler))
    }

    fn is_whole(text: &str) -> bool {
        let Some(rest) = text.strip_prefix("BEGIN ") else {
            return text == "seed";
        };
        let id = rest.split(' ').next().unwrap_or_default();
        text.ends_with(&format!(" END {id}"))
    }

    fn walk(root: &Path, found: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(root).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, found);
            } else {
                found.push(path);
            }
        }
    }

    /// One worker's step: a read, a listing, or one change under the lock.
    /// Every save carries the time the worker last read, and the save is
    /// checked against what was on disk at its turn: a save of a version the
    /// worker never read is a stale save accepted.
    fn step(root: &Path, trash: &Path, rng: &mut XorShift, at: (usize, usize)) -> Option<String> {
        let note = NOTES[rng.below(NOTES.len() as u64) as usize];
        match rng.below(8) {
            0 | 1 => {
                let Ok(read) = read_text(root, note) else {
                    return None;
                };
                let text = stamped(at.0, at.1, rng.below(5000) as usize);
                one_change_at_a_time(|| {
                    let before = fs::read_to_string(root.join(note)).ok();
                    let saved = write_text(root, note, &text, BasedOn::at(read.modified));
                    (saved.is_ok() && before.as_deref() != Some(read.text.as_str())).then(|| {
                        let head = |text: &str| text.chars().take(14).collect::<String>();
                        let disk = before.as_deref().map(head);
                        format!(
                            "stale save of {note} accepted: read {:?}, disk {disk:?}",
                            head(&read.text)
                        )
                    })
                })
            }
            2 => {
                let text = stamped(at.0, at.1, rng.below(5000) as usize);
                let _ = one_change_at_a_time(|| write_text(root, note, &text, BasedOn::ANY));
                None
            }
            3 => {
                let _ = one_change_at_a_time(|| super::create_note_at(root, note, "seed"));
                None
            }
            4 => {
                let (from, to) = if rng.below(2) == 0 {
                    ("F", "H")
                } else {
                    ("H", "F")
                };
                let _ = one_change_at_a_time(|| move_entry_at(root, from, to));
                None
            }
            5 => {
                let into = trash.join(format!("{}-{}", at.0, at.1));
                let _ = one_change_at_a_time(|| {
                    trash_entry_at(root, note, |entry| {
                        fs::rename(entry, &into).map_err(|error| error.to_string())
                    })
                });
                let _ = one_change_at_a_time(|| create_folder_at(root, "F"));
                None
            }
            6 => {
                let _ = one_change_at_a_time(|| replace_binary_at(root, "F/pic.png", &[7; 4096]));
                None
            }
            _ => {
                let _ = list_entries(root, "F");
                read_text(root, note).ok().and_then(|read| {
                    (!is_whole(&read.text)).then(|| format!("torn read of {note}: {:?}", read.text))
                })
            }
        }
    }

    /// Many workers mixing every change and read on the same few paths: no
    /// torn note, no temporary left, no stale save accepted, no deadlock.
    #[test]
    fn a_hammer_of_mixed_changes_leaves_every_note_whole_and_accepts_no_stale_save() {
        const WORKERS: usize = 6;
        const STEPS: usize = 300;
        let vault = tempdir().unwrap();
        let trash = tempdir().unwrap();
        for folder in ["F", "G"] {
            fs::create_dir(vault.path().join(folder)).unwrap();
        }
        for note in NOTES {
            fs::write(vault.path().join(note), "seed").unwrap();
        }
        let violations = Arc::new(Mutex::new(Vec::new()));
        let (done, finished) = mpsc::channel();
        for worker in 0..WORKERS {
            let (root, trash) = (vault.path().to_path_buf(), trash.path().to_path_buf());
            let (violations, done) = (Arc::clone(&violations), done.clone());
            thread::spawn(move || {
                let mut rng = XorShift(0x9E37_79B9_7F4A_7C15 ^ (worker as u64 + 1));
                for at in 0..STEPS {
                    if let Some(violation) = step(&root, &trash, &mut rng, (worker, at)) {
                        violations.lock().unwrap().push(violation);
                    }
                }
                done.send(()).unwrap();
            });
        }
        for _ in 0..WORKERS {
            finished
                .recv_timeout(Duration::from_secs(60))
                .expect("a worker never finished: deadlock");
        }
        let mut files = Vec::new();
        walk(vault.path(), &mut files);
        for file in &files {
            let name = file.file_name().unwrap().to_string_lossy();
            assert!(!name.ends_with(".atlas-tmp"), "temporary left: {file:?}");
            if name.ends_with(".md") {
                let text = fs::read_to_string(file).unwrap();
                assert!(is_whole(&text), "{file:?} is torn: {text:?}");
            }
        }
        let violations = violations.lock().unwrap();
        assert!(
            violations.is_empty(),
            "{} violations, first: {:?}",
            violations.len(),
            violations.first()
        );
    }
}

/// The version a save is checked against, the links it must not follow, and
/// what a switch of vault does to the changes around it.
#[cfg(test)]
mod version_tests {
    use super::{
        change_in_vault, read_one_version, read_text, restore_vault, switch_vault, write_text,
        BasedOn, VaultLocation, VaultState,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tempfile::tempdir;

    fn location(root: &Path) -> VaultLocation {
        VaultLocation {
            absolute_path: root.to_string_lossy().into_owned(),
            name: "vault".into(),
        }
    }

    #[test]
    fn every_save_leaves_a_later_time_than_the_version_it_replaced() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "0").unwrap();
        let mut last = read_text(vault.path(), "a.md").unwrap().modified;
        for version in 1..50 {
            let saved =
                write_text(vault.path(), "a.md", &version.to_string(), BasedOn::ANY).unwrap();
            assert!(saved > last, "version {version}: {saved} after {last}");
            assert_eq!(read_text(vault.path(), "a.md").unwrap().modified, saved);
            last = saved;
        }
    }

    /// A note another program left timed ahead of this Mac's clock gets the
    /// clock's time back from a save, and that version still cannot be saved
    /// over again.
    #[test]
    fn a_save_over_a_note_timed_in_the_future_brings_its_time_back_to_now() {
        let vault = tempdir().unwrap();
        let file = vault.path().join("a.md");
        fs::write(&file, "ahead").unwrap();
        let ahead = SystemTime::now() + Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(ahead)
            .unwrap();
        let opened = read_text(vault.path(), "a.md").unwrap().modified;
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let saved = write_text(vault.path(), "a.md", "mine", BasedOn::at(opened)).unwrap();
        assert!(saved < opened, "{saved} is still in the future");
        assert!(saved + 1000 >= before, "{saved} is not now ({before})");
        assert_eq!(
            write_text(vault.path(), "a.md", "stale", BasedOn::at(opened)),
            Err("the note changed on disk since it was opened".to_string())
        );
    }

    #[test]
    fn a_save_of_a_note_that_links_out_of_the_vault_is_refused_and_writes_nothing() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let victim = outside.path().join("victim.md");
        fs::write(&victim, "not the vault's").unwrap();
        std::os::unix::fs::symlink(&victim, vault.path().join("a.md")).unwrap();

        assert!(write_text(vault.path(), "a.md", "saved", BasedOn::ANY).is_err());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "not the vault's");
        assert!(fs::symlink_metadata(vault.path().join("a.md"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn a_save_never_writes_through_a_link_at_its_temporary_name() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let victim = outside.path().join("victim.txt");
        fs::write(&victim, "not the vault's").unwrap();
        fs::write(vault.path().join("a.md"), "note").unwrap();
        std::os::unix::fs::symlink(&victim, vault.path().join(".a.md.atlas-tmp")).unwrap();

        write_text(vault.path(), "a.md", "saved", BasedOn::ANY).unwrap();

        assert_eq!(fs::read_to_string(&victim).unwrap(), "not the vault's");
        assert_eq!(
            fs::read_to_string(vault.path().join("a.md")).unwrap(),
            "saved"
        );
        assert!(!vault.path().join(".a.md.atlas-tmp").exists());
    }

    #[test]
    fn a_read_is_refused_past_its_limit() {
        let vault = tempdir().unwrap();
        let file = vault.path().join("big.bin");
        fs::write(&file, vec![0u8; 11]).unwrap();
        assert!(read_one_version(&file, 10).is_err());
        assert_eq!(read_one_version(&file, 11).unwrap().0.len(), 11);
    }

    /// Once a switch answers, a change meant for the old vault is refused,
    /// even one that was already waiting for its turn.
    #[test]
    fn a_change_meant_for_a_vault_switched_away_from_is_refused() {
        let (old, new) = (tempdir().unwrap(), tempdir().unwrap());
        let state = VaultState::default();
        switch_vault(&state, &location(old.path()), |_| Ok(())).unwrap();
        let meant = old.path().to_string_lossy().into_owned();
        assert!(change_in_vault(&state, Some(&meant), |_| Ok(())).is_ok());

        switch_vault(&state, &location(new.path()), |_| Ok(())).unwrap();
        let landed = change_in_vault(&state, Some(&meant), |root| {
            fs::write(root.join("late.md"), "late").map_err(|error| error.to_string())
        });
        assert_eq!(
            landed,
            Err("another vault was opened before this could be written".to_string())
        );
        assert!(!old.path().join("late.md").exists());
    }

    #[test]
    fn a_vault_that_cannot_be_remembered_is_not_opened() {
        let (old, new) = (tempdir().unwrap(), tempdir().unwrap());
        let state = VaultState::default();
        switch_vault(&state, &location(old.path()), |_| Ok(())).unwrap();
        let refused = switch_vault(&state, &location(new.path()), |_| Err("disk full".into()));
        assert_eq!(refused, Err("disk full".to_string()));
        assert_eq!(state.get(), Some(old.path().to_path_buf()));
    }

    /// Restoring last launch's vault never replaces one opened meanwhile.
    #[test]
    fn restoring_the_remembered_vault_keeps_one_opened_meanwhile() {
        let (opened, remembered) = (tempdir().unwrap(), tempdir().unwrap());
        let state = VaultState::default();
        let restored = restore_vault(&state, || {
            // The user opens a vault while the remembered one is being read.
            switch_vault(&state, &location(opened.path()), |_| Ok(())).unwrap();
            Some(location(remembered.path()))
        });
        let open = PathBuf::from(restored.unwrap().absolute_path);
        assert_eq!(open, opened.path());
        assert_eq!(state.get(), Some(opened.path().to_path_buf()));
    }

    #[test]
    fn restores_the_remembered_vault_when_none_is_open() {
        let remembered = tempdir().unwrap();
        let state = VaultState::default();
        let restored = restore_vault(&state, || Some(location(remembered.path())));
        assert_eq!(
            PathBuf::from(restored.unwrap().absolute_path),
            remembered.path()
        );
        assert_eq!(state.get(), Some(remembered.path().to_path_buf()));
    }
}

/// Attacks on PR #264 (#258): the time `create_note` reports is the one the
/// app records as its own new note's, so it must be the time on disk once the
/// note is in place, every time, however many creates race.
#[cfg(test)]
mod attack_264_tests {
    use super::{create_note_at, modified_ms, read_notes_at, write_text, BasedOn};
    use crate::vault_entries::create_folder_at;
    use std::fs;
    use std::path::Path;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use tempfile::tempdir;

    const CREATORS: usize = 8;
    const ROUNDS: usize = 25;

    fn on_disk(root: &Path, relative: &str) -> u64 {
        modified_ms(&fs::metadata(root.join(relative)).unwrap()).unwrap()
    }

    fn read_back(root: &Path, relative: &str) -> (String, u64) {
        let note = read_notes_at(root, &[relative.to_string()]).pop().unwrap();
        (note.text, note.modified)
    }

    fn temporaries_in(folder: &Path) -> Vec<String> {
        fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".atlas-tmp"))
            .collect()
    }

    #[test]
    fn the_reported_time_is_the_time_on_disk_for_200_creates_in_a_row() {
        let vault = tempdir().unwrap();
        for at in 0..200 {
            let name = format!("Capture {at}.md");
            let reported = create_note_at(vault.path(), &name, "# Capture\n").unwrap();
            assert_eq!(reported, on_disk(vault.path(), &name), "create {at}");
            assert_eq!(
                read_back(vault.path(), &name).1,
                reported,
                "create {at}, read back"
            );
        }
    }

    #[test]
    fn the_reported_time_is_the_time_on_disk_under_concurrent_creates() {
        let vault = Arc::new(tempdir().unwrap());
        fs::create_dir(vault.path().join("Inbox")).unwrap();
        let start = Arc::new(Barrier::new(CREATORS));
        let creators: Vec<_> = (0..CREATORS)
            .map(|creator| {
                let (vault, start) = (Arc::clone(&vault), Arc::clone(&start));
                thread::spawn(move || {
                    start.wait();
                    (0..ROUNDS)
                        .map(|round| {
                            let name = format!("Inbox/{creator}-{round}.md");
                            let made = create_note_at(vault.path(), &name, &name);
                            (name, made.unwrap())
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let made: Vec<_> = creators
            .into_iter()
            .flat_map(|each| each.join().unwrap())
            .collect();
        for (name, reported) in made {
            assert_eq!(
                read_back(vault.path(), &name),
                (name.clone(), reported),
                "{name}"
            );
        }
    }

    #[test]
    fn of_concurrent_creates_at_one_path_the_winner_reports_the_time_on_disk() {
        for round in 0..ROUNDS {
            let vault = Arc::new(tempdir().unwrap());
            let start = Arc::new(Barrier::new(CREATORS));
            let creators: Vec<_> = (0..CREATORS)
                .map(|creator| {
                    let (vault, start) = (Arc::clone(&vault), Arc::clone(&start));
                    thread::spawn(move || {
                        start.wait();
                        let text = format!("creator {creator}");
                        (
                            text.clone(),
                            create_note_at(vault.path(), "Block type.md", &text),
                        )
                    })
                })
                .collect();
            let results: Vec<_> = creators
                .into_iter()
                .map(|each| each.join().unwrap())
                .collect();
            let winners: Vec<_> = results
                .iter()
                .filter_map(|(text, made)| made.as_ref().ok().map(|time| (text.clone(), *time)))
                .collect();
            assert_eq!(winners.len(), 1, "round {round}: {results:?}");
            assert_eq!(
                read_back(vault.path(), "Block type.md"),
                winners[0],
                "round {round}"
            );
            assert!(results.iter().all(|(_, made)| match made {
                Ok(_) => true,
                Err(error) => error.contains("already exists"),
            }));
            assert_eq!(
                temporaries_in(vault.path()),
                Vec::<String>::new(),
                "round {round}"
            );
        }
    }

    #[test]
    fn a_refused_create_leaves_the_note_there_as_it_was_and_no_temporary() {
        let vault = tempdir().unwrap();
        let first = create_note_at(vault.path(), "Untitled.md", "theirs").unwrap();
        let refused = create_note_at(vault.path(), "Untitled.md", "ours");
        assert!(refused.unwrap_err().contains("already exists"));
        assert_eq!(
            read_back(vault.path(), "Untitled.md"),
            ("theirs".to_string(), first)
        );
        assert_eq!(temporaries_in(vault.path()), Vec::<String>::new());
    }

    #[test]
    fn a_create_into_a_folder_just_made_reports_the_time_on_disk() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("Projects")).unwrap();
        for at in 0..50 {
            let folder = format!("Projects/Area {at}");
            create_folder_at(vault.path(), &folder).unwrap();
            let name = format!("{folder}/Plan.md");
            let reported = create_note_at(vault.path(), &name, "# Plan\n").unwrap();
            assert_eq!(reported, on_disk(vault.path(), &name), "folder {at}");
        }
    }

    #[test]
    fn a_create_over_a_dead_saves_temporary_reports_the_time_on_disk() {
        let vault = tempdir().unwrap();
        fs::write(
            vault.path().join(".Untitled.md.atlas-tmp"),
            "left by a save that died",
        )
        .unwrap();
        let reported = create_note_at(vault.path(), "Untitled.md", "# Untitled\n").unwrap();
        assert_eq!(
            read_back(vault.path(), "Untitled.md"),
            ("# Untitled\n".to_string(), reported)
        );
        assert_eq!(temporaries_in(vault.path()), Vec::<String>::new());
    }

    /// A quick capture creates, then writes at once: two versions, and the
    /// second must be timed other than the first or its echo and its version
    /// check cannot tell them apart.
    #[test]
    fn a_save_straight_after_a_create_leaves_another_time_200_times() {
        let vault = tempdir().unwrap();
        for at in 0..200 {
            let name = format!("Capture {at}.md");
            let created = create_note_at(vault.path(), &name, "# Capture\n").unwrap();
            let saved = write_text(
                vault.path(),
                &name,
                "# Capture\n\nMore.\n",
                BasedOn::at(created),
            );
            let saved = saved.unwrap();
            assert_ne!(saved, created, "capture {at}");
            assert_eq!(saved, on_disk(vault.path(), &name), "capture {at}");
        }
    }
}

/// A save from a version another program has since replaced, on a disk whose
/// clock keeps whole seconds (#245). The other program's write is simulated by
/// writing the same number of bytes and setting the time back to the second
/// the first version had, as HFS+ (1 s) or exFAT (2 s) would leave it.
#[cfg(test)]
mod coarse_clock_tests {
    use super::{read_text, write_text, BasedOn};
    use std::fs;
    use std::path::Path;
    use std::time::{Duration, UNIX_EPOCH};
    use tempfile::tempdir;

    /// A whole second, as a coarse disk keeps every time.
    const TICK: u64 = 1_700_000_000_000;

    fn digest_of(text: &str) -> String {
        super::digest_of(text.as_bytes())
    }

    /// The same vectors the adapter's test holds its digest to
    /// (`tauri-vault-fs.test.ts`): SHA-256 of the UTF-8 bytes, lowercase hex.
    #[test]
    fn the_digest_is_the_sha256_of_the_bytes_in_lowercase_hex() {
        assert_eq!(
            digest_of("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            digest_of("café\n"),
            "7b49b9e063bd91a4f9252b413261f5557b9c570aa61516989499f64a62dbcdd6"
        );
        // A byte-order mark and Windows line ends are bytes like any other.
        assert_eq!(
            digest_of("\u{feff}# T\r\nx\r\n"),
            "305c72150069909fa225462ab528cd57557fee2a22b08a76dda0180ad541e5d3"
        );
    }

    /// Writes `text` over `a.md` and leaves it timed at `TICK`.
    fn write_in_the_tick(root: &Path, text: &str) {
        let file = root.join("a.md");
        fs::write(&file, text).unwrap();
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_millis(TICK))
            .unwrap();
    }

    #[test]
    fn a_save_from_a_version_another_program_replaced_in_the_same_second_is_refused() {
        let vault = tempdir().unwrap();
        write_in_the_tick(vault.path(), "theirs\n");
        let opened = read_text(vault.path(), "a.md").unwrap();
        write_in_the_tick(vault.path(), "other!\n");
        let now = read_text(vault.path(), "a.md").unwrap();
        // The simulation holds: the time and the length are the version read.
        assert_eq!(now.modified, opened.modified);
        assert_eq!(now.text.len(), opened.text.len());

        let digest = digest_of(&opened.text);
        let based_on = BasedOn {
            modified: Some(opened.modified),
            digest: Some(&digest),
        };
        assert_eq!(
            write_text(vault.path(), "a.md", "mine\n", based_on),
            Err("the note changed on disk since it was opened".to_string())
        );
        assert_eq!(
            fs::read_to_string(vault.path().join("a.md")).unwrap(),
            "other!\n"
        );
    }

    #[test]
    fn a_save_from_the_version_on_disk_lands_on_a_coarse_clock() {
        let vault = tempdir().unwrap();
        write_in_the_tick(vault.path(), "theirs\n");
        let opened = read_text(vault.path(), "a.md").unwrap();

        let digest = digest_of(&opened.text);
        let based_on = BasedOn {
            modified: Some(opened.modified),
            digest: Some(&digest),
        };
        let saved = write_text(vault.path(), "a.md", "mine\n", based_on).unwrap();
        assert!(saved > opened.modified);
        assert_eq!(read_text(vault.path(), "a.md").unwrap().text, "mine\n");
    }

    #[test]
    fn a_save_from_a_later_time_is_refused_whatever_its_digest() {
        let vault = tempdir().unwrap();
        write_in_the_tick(vault.path(), "theirs\n");
        let opened = read_text(vault.path(), "a.md").unwrap();

        let digest = digest_of(&opened.text);
        let based_on = BasedOn {
            modified: Some(opened.modified - 1),
            digest: Some(&digest),
        };
        assert!(write_text(vault.path(), "a.md", "mine\n", based_on).is_err());
        assert_eq!(read_text(vault.path(), "a.md").unwrap().text, "theirs\n");
    }

    /// What the digest costs, by hand: `cargo test cost_of -- --ignored --nocapture`.
    /// A save pays one read and one SHA-256 of the note it replaces. A refresh
    /// pays nothing unless the watcher names a note; hashing every note on
    /// every refresh instead is the alternative this measures against.
    #[test]
    #[ignore]
    fn cost_of_the_digest_on_saves_and_on_a_2000_note_vault() {
        use super::{read_notes_at, NoteWalk};
        use std::collections::HashSet;
        use std::time::Instant;

        let vault = tempdir().unwrap();
        for (label, size) in [
            ("5 KB", 5 * 1024),
            ("100 KB", 100 * 1024),
            ("1 MB", 1 << 20),
        ] {
            let text = "x".repeat(size);
            fs::write(vault.path().join("a.md"), &text).unwrap();
            let rounds = 200;
            let mut plain = Duration::ZERO;
            let mut guarded = Duration::ZERO;
            for _ in 0..rounds {
                let opened = read_text(vault.path(), "a.md").unwrap();
                let started = Instant::now();
                write_text(vault.path(), "a.md", &text, BasedOn::at(opened.modified)).unwrap();
                plain += started.elapsed();
                let opened = read_text(vault.path(), "a.md").unwrap();
                let digest = digest_of(&opened.text);
                let based_on = BasedOn {
                    modified: Some(opened.modified),
                    digest: Some(&digest),
                };
                let started = Instant::now();
                write_text(vault.path(), "a.md", &text, based_on).unwrap();
                guarded += started.elapsed();
            }
            println!(
                "save of {label}: {:?} by time alone, {:?} with the digest",
                plain / rounds,
                guarded / rounds
            );
        }

        let notes = tempdir().unwrap();
        let paths: Vec<String> = (0..2000).map(|at| format!("n{at:04}.md")).collect();
        for path in &paths {
            fs::write(notes.path().join(path), "# Note\n\n".repeat(300)).unwrap();
        }
        let skip = HashSet::new();
        let walk = || {
            let mut found = Vec::new();
            NoteWalk {
                root: notes.path(),
                skip: &skip,
                max_depth: 8,
            }
            .collect(notes.path(), "", 0, &mut found);
            found
        };
        let started = Instant::now();
        assert_eq!(walk().len(), 2000);
        let listed = started.elapsed();
        let started = Instant::now();
        let read = read_notes_at(notes.path(), &paths[..1]);
        let one = started.elapsed();
        assert_eq!(read.len(), 1);
        let started = Instant::now();
        let every: Vec<String> = read_notes_at(notes.path(), &paths)
            .iter()
            .map(|note| super::digest_of(note.text.as_bytes()))
            .collect();
        let all = started.elapsed();
        assert_eq!(every.len(), 2000);
        println!(
            "2,000 notes: listing {listed:?}; reading the one note named {one:?}; \
             reading and hashing every note {all:?}"
        );
    }

    /// The contract before #245, kept for a caller that sends no digest.
    #[test]
    fn a_save_that_sends_no_digest_is_held_to_the_time_alone() {
        let vault = tempdir().unwrap();
        write_in_the_tick(vault.path(), "theirs\n");
        let opened = read_text(vault.path(), "a.md").unwrap();
        write_in_the_tick(vault.path(), "other!\n");

        assert!(write_text(vault.path(), "a.md", "mine\n", BasedOn::at(opened.modified)).is_ok());
    }
}

/// Attack on #281 (#245): the byte check against outside writes in the same
/// tick, the encodings a note can hold, and notes near the size limit.
#[cfg(test)]
mod attack_281_tests {
    use super::{read_text, write_text, BasedOn, MAX_TEXT_BYTES};
    use std::fs;
    use std::path::Path;
    use std::time::{Duration, Instant, UNIX_EPOCH};
    use tempfile::tempdir;

    const TICK: u64 = 1_700_000_000_000;

    fn write_bytes_in_the_tick(root: &Path, bytes: &[u8]) {
        let file = root.join("a.md");
        fs::write(&file, bytes).unwrap();
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_millis(TICK))
            .unwrap();
    }

    /// Saves `contents` from the version read as `opened`, naming its time and its digest.
    fn save_from(root: &Path, opened: &super::NoteContents, contents: &str) -> Result<u64, String> {
        let digest = super::digest_of(opened.text.as_bytes());
        write_text(
            root,
            "a.md",
            contents,
            BasedOn {
                modified: Some(opened.modified),
                digest: Some(&digest),
            },
        )
    }

    fn on_disk(root: &Path) -> Vec<u8> {
        fs::read(root.join("a.md")).unwrap()
    }

    #[test]
    fn a_save_over_a_different_length_edit_in_the_same_tick_is_refused() {
        let vault = tempdir().unwrap();
        write_bytes_in_the_tick(vault.path(), b"theirs\n");
        let opened = read_text(vault.path(), "a.md").unwrap();
        write_bytes_in_the_tick(vault.path(), b"theirs, and longer\n");

        assert!(save_from(vault.path(), &opened, "mine\n").is_err());
        assert_eq!(on_disk(vault.path()), b"theirs, and longer\n");
    }

    #[test]
    fn a_save_over_an_edit_that_put_back_the_bytes_read_lands() {
        // Nothing is lost: the file holds exactly what the save was made from.
        let vault = tempdir().unwrap();
        write_bytes_in_the_tick(vault.path(), b"theirs\n");
        let opened = read_text(vault.path(), "a.md").unwrap();
        write_bytes_in_the_tick(vault.path(), b"other!\n");
        write_bytes_in_the_tick(vault.path(), b"theirs\n");

        assert!(save_from(vault.path(), &opened, "mine\n").is_ok());
        assert_eq!(on_disk(vault.path()), b"mine\n");
    }

    #[test]
    fn a_note_with_a_bom_crlf_nfd_and_no_trailing_newline_saves_from_its_own_read() {
        let vault = tempdir().unwrap();
        let text = "\u{feff}# Cafe\u{301}\r\n\r\nLine one\r\nno newline at the end";
        write_bytes_in_the_tick(vault.path(), text.as_bytes());
        let opened = read_text(vault.path(), "a.md").unwrap();
        assert_eq!(opened.text, text);

        let saved = save_from(vault.path(), &opened, "\u{feff}# Café\r\n").unwrap();
        assert!(saved > opened.modified);
        assert_eq!(on_disk(vault.path()), "\u{feff}# Café\r\n".as_bytes());
    }

    #[test]
    fn a_same_tick_edit_that_only_changes_line_endings_or_the_bom_is_refused() {
        for (read, theirs) in [
            ("a\r\nb\n", "a\nb\r\n"),
            ("\u{feff}abc\n", "abc\n\n\n\n"),
            ("Cafe\u{301}\n", "Café!\n"),
        ] {
            let vault = tempdir().unwrap();
            write_bytes_in_the_tick(vault.path(), read.as_bytes());
            let opened = read_text(vault.path(), "a.md").unwrap();
            assert_eq!(theirs.len(), read.len(), "{theirs:?} is the same length");
            write_bytes_in_the_tick(vault.path(), theirs.as_bytes());

            assert!(
                save_from(vault.path(), &opened, "mine\n").is_err(),
                "{read:?}"
            );
            assert_eq!(on_disk(vault.path()), theirs.as_bytes());
        }
    }

    #[test]
    fn a_save_from_a_note_with_bytes_that_are_not_utf8_is_refused_not_written() {
        // Such a note cannot be read as text, so no pane holds it; a save that
        // names a digest of some text cannot match its bytes.
        let vault = tempdir().unwrap();
        write_bytes_in_the_tick(vault.path(), b"ok\n");
        let opened = read_text(vault.path(), "a.md").unwrap();
        write_bytes_in_the_tick(vault.path(), b"o\xff\n");

        assert!(save_from(vault.path(), &opened, "mine\n").is_err());
        assert_eq!(on_disk(vault.path()), b"o\xff\n");
    }

    /// A save is not held to the read limit, so a note can grow past it in
    /// the editor; the next save, which names its digest, then has to read
    /// the note to check it and is refused as too large.
    #[test]
    fn the_save_after_one_that_grew_the_note_past_the_read_limit_lands() {
        let vault = tempdir().unwrap();
        write_bytes_in_the_tick(vault.path(), b"small\n");
        let opened = read_text(vault.path(), "a.md").unwrap();
        let big = "x".repeat(MAX_TEXT_BYTES as usize + 1);
        let first = save_from(vault.path(), &opened, &big).unwrap();

        let grown = super::NoteContents {
            text: big.clone(),
            modified: first,
        };
        let second = save_from(vault.path(), &grown, &format!("{big}y"));

        assert!(second.is_ok(), "refused: {second:?}");
    }

    /// A benchmark, by hand: a wall-clock bound fails on a loaded Mac however
    /// quick the save (4.9 s once, against 0.7 s alone), so it is not part of
    /// the gate. `cargo test a_digest_save -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn a_digest_save_of_1_mb_and_5_mb_stays_quick() {
        for (label, size) in [("1 MB", 1usize << 20), ("5 MB", 5usize << 20)] {
            let vault = tempdir().unwrap();
            let text = "x".repeat(size);
            write_bytes_in_the_tick(vault.path(), text.as_bytes());
            let opened = read_text(vault.path(), "a.md").unwrap();
            let started = Instant::now();
            save_from(vault.path(), &opened, &text).unwrap();
            let took = started.elapsed();
            println!("digest save of {label}: {took:?}");
            // Generous: a debug build on a loaded Mac, not a benchmark.
            assert!(took < Duration::from_secs(3), "{label} took {took:?}");
        }
    }
}
