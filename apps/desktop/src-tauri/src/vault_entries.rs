//! Making, moving and throwing away entries in the vault: folders as well as notes.
//!
//! Like the rest of the host this decides nothing (ADR-0005). Which folder a note
//! may go to, what is protected and what to do with an open pane are the
//! frontend's rules; here a path is checked to be inside the vault, the move is
//! refused rather than writing over something, moving what a link reaches, or
//! changing what a link it carries points at (#680; a link elsewhere into what
//! moves is issue #686), and that is all.

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::vault::{
    change_in_vault, change_turn, is_as_read, off_main, rename_exclusive, resolve_new, BasedOn,
    VaultState,
};

/// An entry that is already there, as itself: a link is the link, not what it
/// points at.
///
/// `resolve` canonicalises the whole path, which would move a symlink's target
/// instead of the link. Here only the parent is canonicalised and checked, the
/// way a new entry's is, and the name is then required to exist.
fn resolve_entry(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let entry = resolve_new(root, relative)?;
    fs::symlink_metadata(&entry).map_err(|error| format!("no such entry: {error}"))?;
    Ok(entry)
}

/// The same file or folder, whatever either path is spelled like.
///
/// Compared by device and inode rather than by path, so that a case-only rename
/// on a case-insensitive disk is recognised as the one entry it is.
fn same_entry(left: &Path, right: &Path) -> bool {
    match (fs::symlink_metadata(left), fs::symlink_metadata(right)) {
        (Ok(left), Ok(right)) => left.dev() == right.dev() && left.ino() == right.ino(),
        _ => false,
    }
}

/// Whether `folder` is `inside` or one of the folders above it, up to the vault.
fn contains(folder: &Path, inside: &Path) -> bool {
    inside
        .ancestors()
        .any(|ancestor| same_entry(folder, ancestor))
}

/// Creates an empty folder, refusing when anything already has the name.
pub(crate) fn create_folder_at(root: &Path, relative: &str) -> Result<(), String> {
    let _turn = change_turn();
    let folder = resolve_new(root, relative)?;
    fs::create_dir(&folder).map_err(|error| match error.kind() {
        std::io::ErrorKind::AlreadyExists => "something with that name is already there".into(),
        _ => format!("cannot create the folder: {error}"),
    })
}

/// Moves a note or a folder, refusing to write over anything.
///
/// A folder cannot go inside itself — the rename would fail halfway on some
/// systems and orphan the tree on others. A move whose target is the source
/// spelled in another case is a rename of that one entry, which a
/// case-insensitive disk would otherwise report as a collision with itself.
pub(crate) fn move_entry_at(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let _turn = change_turn();
    let source = resolve_entry(root, from)?;
    let target = resolve_new(root, to)?;
    refuse_through_link(root, from)?;

    if source == target {
        return Ok(());
    }
    let is_folder = fs::symlink_metadata(&source)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false);
    if is_folder
        && target
            .parent()
            .is_some_and(|parent| contains(&source, parent))
    {
        return Err("a folder cannot be moved into itself".into());
    }
    // The source under another spelling: a case-only rename, which has to
    // replace "itself" and so cannot be exclusive.
    if is_case_only_rename(&source, &target) {
        return fs::rename(&source, &target).map_err(|error| format!("cannot move: {error}"));
    }
    refuse_retargeted_links(root, &source, &target)?;

    rename_exclusive(&source, &target).map_err(|error| match error.kind() {
        std::io::ErrorKind::AlreadyExists => "something with that name is already there".into(),
        _ => format!("cannot move: {error}"),
    })
}

/// Refuses a path whose way to its last name passes a link (#680).
///
/// `resolve_new` follows a link inside the vault, so `Work/Alias/Plans`, with
/// `Work/Alias` a link to `Shelf`, would move the real `Shelf/Plans` while the
/// app believes it moved another path, and would rewrite links and re-point
/// panes on that belief. The name itself may be a link: that is moved as the
/// link. A move *into* a folder by a link is left alone: it lands where the
/// link points, which is still the path the app re-points to, so nothing is
/// lost — and a note's image or a filed note may well go there.
fn refuse_through_link(root: &Path, relative: &str) -> Result<(), String> {
    let segments: Vec<&str> = relative
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let Some((_, folders)) = segments.split_last() else {
        return Ok(());
    };
    let mut at = root.to_path_buf();
    for (depth, segment) in folders.iter().enumerate() {
        at.push(segment);
        let is_link =
            fs::symlink_metadata(&at).is_ok_and(|metadata| metadata.file_type().is_symlink());
        if is_link {
            return Err(format!(
                "path goes through a link: {}",
                folders[..=depth].join("/")
            ));
        }
    }
    Ok(())
}

/// Refuses a move that would change what a link it carries points at (#680).
///
/// A rename takes a link as the link and a folder whole, links and all, but a
/// relative link is read from where it is: `../Shelf` moved a folder deeper
/// points at another `Shelf`, or at nothing. A link into the moved folder by an
/// absolute path is left pointing at where the folder was. A link that still
/// points at the same thing afterwards — at the same place, or into the folder
/// as it moved — is fine. Nothing is followed, so a link loop costs nothing.
/// Paths are compared as the disk spells them, so a vault reached through a
/// link, another case or another Unicode form is still recognised.
///
/// Only the links the move carries are checked. A link elsewhere that points
/// into the moved folder (`Work/latest -> ../Projects/v2`) is issue #686.
fn refuse_retargeted_links(root: &Path, source: &Path, target: &Path) -> Result<(), String> {
    let vault = root
        .canonicalize()
        .map_err(|error| format!("vault is unreadable: {error}"))?;
    let shown = |at: &Path| at.strip_prefix(&vault).unwrap_or(at).display().to_string();
    let source = &spelled_on_disk(source)?;
    let mut waiting = vec![source.clone()];
    while let Some(at) = waiting.pop() {
        let metadata = match fs::symlink_metadata(&at) {
            Ok(metadata) => metadata,
            // Gone since its folder was read: nothing there to re-point.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(cannot_check(&shown(&at), &error)),
        };
        if metadata.file_type().is_symlink() {
            let points_at =
                fs::read_link(&at).map_err(|error| cannot_check(&shown(&at), &error))?;
            let carried = CarriedLink {
                source,
                target,
                link: &at,
                points_at: &points_at,
            };
            if !carried.keeps_pointing() {
                return Err(format!(
                    "moving it would point a link elsewhere: {}",
                    shown(&at)
                ));
            }
        } else if metadata.is_dir() {
            waiting.extend(entries_of(&at).map_err(|error| cannot_check(&shown(&at), &error))?);
        }
    }
    Ok(())
}

/// The paths in `folder`; none when it went away after it was found.
fn entries_of(folder: &Path) -> std::io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    entries
        .map(|entry| entry.map(|entry| entry.path()))
        .collect()
}

/// Why a move is refused when what it carries cannot be looked at: a link in
/// there might be re-pointed, and that cannot be ruled out.
fn cannot_check(shown: &str, error: &std::io::Error) -> String {
    let reason = match error.kind() {
        std::io::ErrorKind::PermissionDenied => "permission denied".to_string(),
        _ => error.to_string(),
    };
    format!("cannot check the links inside {shown}: {reason}")
}

/// `entry` as the disk spells it. A link is taken as itself: only the folder
/// it is in is looked up.
fn spelled_on_disk(entry: &Path) -> Result<PathBuf, String> {
    let is_link = fs::symlink_metadata(entry).is_ok_and(|metadata| metadata.is_symlink());
    if is_link {
        return Ok(entry.to_path_buf());
    }
    match entry.canonicalize() {
        Ok(spelled) => Ok(spelled),
        // Gone already: the walk finds nothing in it, and the rename says so.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(entry.to_path_buf()),
        Err(error) => Err(format!("cannot move: {error}")),
    }
}

/// A link the move carries, and where it is going.
struct CarriedLink<'a> {
    source: &'a Path,
    target: &'a Path,
    link: &'a Path,
    points_at: &'a Path,
}

impl CarriedLink<'_> {
    /// Whether the link points at the same thing once the source is at the
    /// target: where it pointed, carried by the move if that was inside it.
    fn keeps_pointing(&self) -> bool {
        let Some(moved_link) = moved(self.link, self.source, self.target) else {
            return true;
        };
        let read_from = |at: &Path| at.parent().map_or_else(PathBuf::new, Path::to_path_buf);
        let before = as_disk_spells(&read_from(self.link).join(self.points_at));
        let after = as_disk_spells(&read_from(&moved_link).join(self.points_at));
        let expected = moved(&before, self.source, self.target).unwrap_or(before);
        after == expected
    }
}

/// Where `path` is once `source` is at `target`, or None when it is not inside it.
fn moved(path: &Path, source: &Path, target: &Path) -> Option<PathBuf> {
    let rest = path.strip_prefix(source).ok()?;
    Some(if rest.as_os_str().is_empty() {
        target.to_path_buf()
    } else {
        target.join(rest)
    })
}

/// `path` worked out by name, then with the deepest folder of it that exists
/// spelled as the disk spells it. Its last name is never looked up, so a link
/// there is not followed.
fn as_disk_spells(path: &Path) -> PathBuf {
    let named = by_name(path);
    let mut rest = Vec::new();
    let mut at = named.as_path();
    while let (Some(parent), Some(name)) = (at.parent(), at.file_name()) {
        rest.push(name.to_os_string());
        if let Ok(real) = parent.canonicalize() {
            return rest.iter().rev().fold(real, |whole, part| whole.join(part));
        }
        at = parent;
    }
    named
}

/// `path` with `.` and `..` worked out by name alone, without asking the disk.
fn by_name(path: &Path) -> PathBuf {
    let mut worked_out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                worked_out.pop();
            }
            other => worked_out.push(other),
        }
    }
    worked_out
}

/// Whether `target` is `source` itself, its name spelled in another case.
///
/// Two hard links to one file look like one entry too, but `a.md` onto `B.md`,
/// where `b.md` is the other link, is a move onto another name: a plain rename
/// between them does nothing and reports success, so it must stay exclusive.
fn is_case_only_rename(source: &Path, target: &Path) -> bool {
    let spelled = |path: &Path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
    };
    source.parent() == target.parent()
        && spelled(source) == spelled(target)
        && same_entry(source, target)
        && !is_listed_as_itself(target)
}

/// Whether `path`'s own name is an entry of its folder, spelled exactly so.
///
/// A second hard link to a file and the same file named in another case on a
/// case-insensitive disk both look like one inode; only the first is really
/// another name in the folder.
fn is_listed_as_itself(path: &Path) -> bool {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return false;
    };
    fs::read_dir(parent).is_ok_and(|entries| {
        entries
            .filter_map(Result::ok)
            .any(|entry| entry.file_name() == name)
    })
}

/// Puts a note or a folder in the Trash through `trash`, and nothing else.
///
/// Taking the way to the Trash as an argument is what lets the tests check the
/// path handling without filling the real Trash; the command hands over the
/// system one. There is deliberately no fallback: if the Trash refuses, the
/// error is the answer, never a permanent delete in its place. The command
/// trashes through `trash_entry_at_unless_changed`; this is the tests' way in
/// with no file to hold still.
#[cfg(test)]
pub(crate) fn trash_entry_at(
    root: &Path,
    relative: &str,
    trash: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    trash_entry_at_unless_changed(root, relative, &[], trash)
}

/// What a trash is refused with when a file it was to hold still has changed.
pub(crate) const CHANGED_SINCE_READ: &str =
    "a file changed on disk since it was read, so nothing was moved to the Trash";

/// A file as the client read it: its time, and the SHA-256 of its bytes.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unchanged {
    pub path: String,
    pub modified: u64,
    pub digest: String,
}

/// `trash_entry_at`, only while every file in `unchanged` is as it was read
/// (#235). The checks and the Trash are one change: nothing else in the vault
/// changes between them. Which files to hold still is the client's to say;
/// this only compares, as `write_text_file` does its `expected_modified`.
pub(crate) fn trash_entry_at_unless_changed(
    root: &Path,
    relative: &str,
    unchanged: &[Unchanged],
    trash: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let _turn = change_turn();
    for file in unchanged {
        let read = BasedOn {
            modified: Some(file.modified),
            digest: Some(&file.digest),
        };
        if !is_as_read(root, &file.path, read)? {
            return Err(CHANGED_SINCE_READ.into());
        }
    }
    let entry = resolve_entry(root, relative)?;
    trash(&entry)
}

/// The system Trash: on macOS through `NSFileManager`, which needs no Finder
/// automation permission and so never stops to ask for one. The Finder method
/// would add "Put Back", at the price of an Apple Events prompt the first time
/// anything is deleted.
fn system_trash(entry: &Path) -> Result<(), String> {
    let mut context = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context
        .delete(entry)
        .map_err(|error| format!("cannot move to the Trash: {error}"))
}

#[tauri::command]
pub async fn create_folder(app: AppHandle, path: String, vault: String) -> Result<(), String> {
    off_main(move || {
        change_in_vault(&app.state::<VaultState>(), Some(&vault), |root| {
            create_folder_at(root, &path)
        })?;
        log::info!("created folder {path}");
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn move_entry(
    app: AppHandle,
    from: String,
    to: String,
    vault: String,
) -> Result<(), String> {
    off_main(move || {
        change_in_vault(&app.state::<VaultState>(), Some(&vault), |root| {
            move_entry_at(root, &from, &to)
        })?;
        log::info!("moved {from} to {to}");
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn trash_entry(
    app: AppHandle,
    path: String,
    vault: String,
    unchanged: Option<Vec<Unchanged>>,
) -> Result<(), String> {
    off_main(move || {
        change_in_vault(&app.state::<VaultState>(), Some(&vault), |root| {
            trash_entry_at_unless_changed(
                root,
                &path,
                unchanged.as_deref().unwrap_or_default(),
                system_trash,
            )
        })?;
        log::info!("moved {path} to the Trash");
        Ok(())
    })
    .await
}

#[cfg(test)]
mod folder_tests {
    use super::create_folder_at;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn creates_a_folder() {
        let vault = tempdir().unwrap();
        create_folder_at(vault.path(), "Projects").unwrap();
        assert!(vault.path().join("Projects").is_dir());
    }

    #[test]
    fn creates_a_folder_inside_a_folder() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("Projects")).unwrap();
        create_folder_at(vault.path(), "Projects/DFAI").unwrap();
        assert!(vault.path().join("Projects/DFAI").is_dir());
    }

    #[test]
    fn refuses_a_name_already_taken_by_a_folder_or_a_note() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("Projects")).unwrap();
        fs::write(vault.path().join("Notes"), "x").unwrap();

        for taken in ["Projects", "Notes"] {
            assert_eq!(
                create_folder_at(vault.path(), taken).unwrap_err(),
                "something with that name is already there"
            );
        }
        assert_eq!(fs::read_to_string(vault.path().join("Notes")).unwrap(), "x");
    }

    #[test]
    fn refuses_a_parent_that_does_not_exist() {
        let vault = tempdir().unwrap();
        assert_eq!(
            create_folder_at(vault.path(), "Nowhere/Here").unwrap_err(),
            "that folder does not exist"
        );
    }

    #[test]
    fn refuses_to_climb_out_of_the_vault() {
        let vault = tempdir().unwrap();
        assert!(create_folder_at(vault.path(), "../escaped").is_err());
        assert!(!vault.path().parent().unwrap().join("escaped").exists());
    }

    #[test]
    fn refuses_an_absolute_path() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let absolute = outside.path().join("made").to_string_lossy().into_owned();
        assert!(create_folder_at(vault.path(), &absolute).is_err());
        assert!(!outside.path().join("made").exists());
    }

    #[test]
    fn refuses_to_create_through_a_link_leaving_the_vault() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), vault.path().join("escape")).unwrap();

        assert_eq!(
            create_folder_at(vault.path(), "escape/made").unwrap_err(),
            "path escapes the vault"
        );
        assert!(!outside.path().join("made").exists());
    }

    #[test]
    fn refuses_the_vault_itself() {
        let vault = tempdir().unwrap();
        assert!(create_folder_at(vault.path(), "").is_err());
    }
}

#[cfg(test)]
mod move_link_tests;

#[cfg(test)]
mod move_tests {
    use super::move_entry_at;
    use std::fs;
    use tempfile::tempdir;

    fn names_in(folder: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn renames_a_note_keeping_its_contents() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("old.md"), "# Old\n").unwrap();

        move_entry_at(vault.path(), "old.md", "new.md").unwrap();

        assert!(!vault.path().join("old.md").exists());
        assert_eq!(
            fs::read_to_string(vault.path().join("new.md")).unwrap(),
            "# Old\n"
        );
    }

    #[test]
    fn moves_a_note_into_a_folder() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("Notes")).unwrap();
        fs::write(vault.path().join("a.md"), "x").unwrap();

        move_entry_at(vault.path(), "a.md", "Notes/a.md").unwrap();
        assert!(vault.path().join("Notes/a.md").is_file());
        assert!(!vault.path().join("a.md").exists());
    }

    /// The editor holds the time it read a note at, and saves against it: a move
    /// must not look like an edit made somewhere else.
    #[test]
    fn keeps_the_note_modification_time() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("Notes")).unwrap();
        fs::write(vault.path().join("a.md"), "x").unwrap();
        let before = fs::metadata(vault.path().join("a.md"))
            .unwrap()
            .modified()
            .unwrap();

        move_entry_at(vault.path(), "a.md", "Notes/a.md").unwrap();
        let after = fs::metadata(vault.path().join("Notes/a.md"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn moves_a_folder_with_everything_in_it() {
        let vault = tempdir().unwrap();
        fs::create_dir_all(vault.path().join("Projects/DFAI")).unwrap();
        fs::write(vault.path().join("Projects/DFAI/plan.md"), "plan").unwrap();
        fs::create_dir(vault.path().join("Archive")).unwrap();

        move_entry_at(vault.path(), "Projects", "Archive/Projects").unwrap();

        assert_eq!(
            fs::read_to_string(vault.path().join("Archive/Projects/DFAI/plan.md")).unwrap(),
            "plan"
        );
        assert!(!vault.path().join("Projects").exists());
    }

    #[test]
    fn refuses_to_write_over_another_note() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "first").unwrap();
        fs::write(vault.path().join("b.md"), "second").unwrap();

        assert_eq!(
            move_entry_at(vault.path(), "a.md", "b.md").unwrap_err(),
            "something with that name is already there"
        );
        assert_eq!(
            fs::read_to_string(vault.path().join("b.md")).unwrap(),
            "second"
        );
        assert!(vault.path().join("a.md").is_file());
    }

    #[test]
    fn refuses_to_write_a_folder_over_another_folder() {
        let vault = tempdir().unwrap();
        fs::create_dir_all(vault.path().join("One")).unwrap();
        fs::create_dir_all(vault.path().join("Two")).unwrap();
        fs::write(vault.path().join("Two/kept.md"), "kept").unwrap();

        assert!(move_entry_at(vault.path(), "One", "Two").is_err());
        assert!(vault.path().join("Two/kept.md").is_file());
        assert!(vault.path().join("One").is_dir());
    }

    #[test]
    fn refuses_to_move_a_folder_into_itself() {
        let vault = tempdir().unwrap();
        fs::create_dir_all(vault.path().join("Projects/DFAI")).unwrap();

        for inside in ["Projects/Projects", "Projects/DFAI/Projects"] {
            assert_eq!(
                move_entry_at(vault.path(), "Projects", inside).unwrap_err(),
                "a folder cannot be moved into itself"
            );
        }
        assert!(vault.path().join("Projects/DFAI").is_dir());
    }

    /// A folder whose name only starts the same is not inside it.
    #[test]
    fn moves_a_folder_beside_one_with_a_longer_name() {
        let vault = tempdir().unwrap();
        fs::create_dir_all(vault.path().join("Projects")).unwrap();
        fs::create_dir_all(vault.path().join("Projects Old")).unwrap();

        move_entry_at(vault.path(), "Projects", "Projects Old/Projects").unwrap();
        assert!(vault.path().join("Projects Old/Projects").is_dir());
    }

    /// On APFS `a.md` and `A.md` are one file: renaming one to the other must
    /// change the name's case, not be refused as a collision with itself.
    #[test]
    fn a_case_only_rename_changes_the_case() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("meeting.md"), "x").unwrap();

        move_entry_at(vault.path(), "meeting.md", "Meeting.md").unwrap();

        assert_eq!(names_in(vault.path()), vec!["Meeting.md".to_string()]);
    }

    #[test]
    fn a_case_only_rename_of_a_folder_changes_the_case() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("projects")).unwrap();
        fs::write(vault.path().join("projects/a.md"), "x").unwrap();

        move_entry_at(vault.path(), "projects", "Projects").unwrap();

        assert_eq!(names_in(vault.path()), vec!["Projects".to_string()]);
        assert!(vault.path().join("Projects/a.md").is_file());
    }

    #[test]
    fn moving_to_the_same_path_does_nothing() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "x").unwrap();
        assert!(move_entry_at(vault.path(), "a.md", "a.md").is_ok());
        assert!(vault.path().join("a.md").is_file());
    }

    #[test]
    fn refuses_to_move_out_of_the_vault() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "x").unwrap();

        assert!(move_entry_at(vault.path(), "a.md", "../escaped.md").is_err());
        assert!(vault.path().join("a.md").is_file());
        assert!(!vault.path().parent().unwrap().join("escaped.md").exists());
    }

    #[test]
    fn refuses_to_move_something_from_outside_the_vault() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "x").unwrap();
        let absolute = outside
            .path()
            .join("secret.md")
            .to_string_lossy()
            .into_owned();

        assert!(move_entry_at(vault.path(), &absolute, "stolen.md").is_err());
        assert!(move_entry_at(vault.path(), "../secret.md", "stolen.md").is_err());
        assert!(outside.path().join("secret.md").is_file());
    }

    #[test]
    fn refuses_to_move_into_a_link_leaving_the_vault() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path(), vault.path().join("escape")).unwrap();

        assert_eq!(
            move_entry_at(vault.path(), "a.md", "escape/a.md").unwrap_err(),
            "path escapes the vault"
        );
        assert!(!outside.path().join("a.md").exists());
    }

    /// Moving a link moves the link: what it points at stays where it is.
    #[test]
    fn moves_a_link_rather_than_what_it_points_at() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("elsewhere.md"), "x").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("elsewhere.md"),
            vault.path().join("link.md"),
        )
        .unwrap();

        move_entry_at(vault.path(), "link.md", "moved.md").unwrap();

        assert!(outside.path().join("elsewhere.md").is_file());
        assert!(fs::symlink_metadata(vault.path().join("moved.md"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn refuses_an_entry_that_is_not_there() {
        let vault = tempdir().unwrap();
        assert!(move_entry_at(vault.path(), "gone.md", "new.md").is_err());
    }

    #[test]
    fn refuses_to_move_the_vault_itself() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("Inside")).unwrap();
        assert!(move_entry_at(vault.path(), "", "Inside/vault").is_err());
    }

    /// The move's own check can pass and something take the name before the
    /// rename runs. The rename itself must then refuse: here the target is
    /// created after any check could have looked, and handed straight to it.
    #[test]
    fn the_rename_itself_refuses_a_target_that_appeared_after_the_check() {
        let vault = tempdir().unwrap();
        let (from, to) = (vault.path().join("a.md"), vault.path().join("b.md"));
        fs::write(&from, "mine").unwrap();
        fs::write(&to, "theirs").unwrap();

        let renamed = super::rename_exclusive(&from, &to);

        assert_eq!(
            renamed.map_err(|error| error.kind()),
            Err(std::io::ErrorKind::AlreadyExists)
        );
        assert_eq!(fs::read_to_string(&from).unwrap(), "mine");
        assert_eq!(fs::read_to_string(&to).unwrap(), "theirs");
    }

    #[test]
    fn the_exclusive_rename_moves_a_folder_to_a_free_name() {
        let vault = tempdir().unwrap();
        fs::create_dir(vault.path().join("old")).unwrap();
        fs::write(vault.path().join("old/n.md"), "x").unwrap();

        super::rename_exclusive(&vault.path().join("old"), &vault.path().join("new")).unwrap();

        assert_eq!(names_in(vault.path()), ["new"]);
        assert!(vault.path().join("new/n.md").is_file());
    }

    /// Two names for one inode pass `same_entry`, and rename(2) between hard
    /// links of the same file does nothing and succeeds: the move reports Ok
    /// while `a.md` is still there and `b.md` was already taken.
    #[test]
    fn a_move_onto_a_hard_link_of_itself_is_refused_or_really_moves() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "x").unwrap();
        fs::hard_link(vault.path().join("a.md"), vault.path().join("b.md")).unwrap();

        let moved = move_entry_at(vault.path(), "a.md", "b.md");
        assert!(
            moved.is_err() || !vault.path().join("a.md").exists(),
            "reported {moved:?} but a.md is still there"
        );
    }

    #[test]
    fn a_move_into_a_folder_named_like_the_source_in_another_case_is_refused() {
        let vault = tempdir().unwrap();
        fs::create_dir_all(vault.path().join("Projects/Sub")).unwrap();
        assert!(move_entry_at(vault.path(), "Projects", "projects/Sub/Projects").is_err());
        assert!(vault.path().join("Projects/Sub").is_dir());
    }

    #[test]
    fn refuses_names_that_are_only_dots() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "x").unwrap();
        for bad in [".", "..", "./", "Notes/.."] {
            assert!(move_entry_at(vault.path(), "a.md", bad).is_err(), "{bad}");
        }
        assert!(vault.path().join("a.md").is_file());
    }
}

#[cfg(test)]
mod trash_tests {
    use super::{trash_entry_at, trash_entry_at_unless_changed, Unchanged, CHANGED_SINCE_READ};
    use std::fs;
    use std::path::{Path, PathBuf};
    use tempfile::tempdir;

    /// A Trash that is a folder, so a test can see what went there.
    fn into(bin: &Path) -> impl FnOnce(&Path) -> Result<(), String> + '_ {
        move |entry: &Path| {
            let name = entry.file_name().unwrap();
            fs::rename(entry, bin.join(name)).map_err(|error| error.to_string())
        }
    }

    #[test]
    fn puts_a_note_in_the_trash() {
        let vault = tempdir().unwrap();
        let bin = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "kept in the bin").unwrap();

        trash_entry_at(vault.path(), "a.md", into(bin.path())).unwrap();

        assert!(!vault.path().join("a.md").exists());
        assert_eq!(
            fs::read_to_string(bin.path().join("a.md")).unwrap(),
            "kept in the bin"
        );
    }

    #[test]
    fn puts_a_folder_in_the_trash_whole() {
        let vault = tempdir().unwrap();
        let bin = tempdir().unwrap();
        fs::create_dir_all(vault.path().join("Old/Deeper")).unwrap();
        fs::write(vault.path().join("Old/Deeper/a.md"), "x").unwrap();

        trash_entry_at(vault.path(), "Old", into(bin.path())).unwrap();

        assert!(!vault.path().join("Old").exists());
        assert!(bin.path().join("Old/Deeper/a.md").is_file());
    }

    /// No fallback: a Trash that refuses leaves the note exactly where it was.
    #[test]
    fn a_refusal_from_the_trash_is_the_answer_and_nothing_is_deleted() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("a.md"), "x").unwrap();

        let error =
            trash_entry_at(vault.path(), "a.md", |_| Err("the Trash said no".into())).unwrap_err();

        assert_eq!(error, "the Trash said no");
        assert!(vault.path().join("a.md").is_file());
    }

    #[test]
    fn refuses_anything_outside_the_vault_without_asking_the_trash() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path(), vault.path().join("escape")).unwrap();
        let absolute = outside
            .path()
            .join("secret.md")
            .to_string_lossy()
            .into_owned();

        for path in ["../secret.md", absolute.as_str(), "escape/secret.md"] {
            let asked: std::cell::Cell<Option<PathBuf>> = std::cell::Cell::new(None);
            let result = trash_entry_at(vault.path(), path, |entry| {
                asked.set(Some(entry.to_path_buf()));
                Ok(())
            });
            assert!(result.is_err(), "{path} was accepted");
            assert!(asked.take().is_none(), "{path} reached the Trash");
        }
        assert!(outside.path().join("secret.md").is_file());
    }

    /// A link inside the vault is thrown away as the link, never its target.
    #[test]
    fn trashes_a_link_rather_than_what_it_points_at() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("elsewhere.md"), "x").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("elsewhere.md"),
            vault.path().join("link.md"),
        )
        .unwrap();

        let mut asked = None;
        trash_entry_at(vault.path(), "link.md", |entry| {
            asked = Some(entry.to_path_buf());
            Ok(())
        })
        .unwrap();

        assert_eq!(asked.unwrap().file_name().unwrap(), "link.md");
    }

    #[test]
    fn refuses_the_vault_itself() {
        let vault = tempdir().unwrap();
        assert!(trash_entry_at(vault.path(), "", |_| Ok(())).is_err());
    }

    #[test]
    fn refuses_an_entry_that_is_not_there() {
        let vault = tempdir().unwrap();
        assert!(trash_entry_at(vault.path(), "gone.md", |_| Ok(())).is_err());
    }

    /// A file as it was read: its time and the SHA-256 of its bytes (#235).
    fn as_read(root: &Path, path: &str) -> Unchanged {
        use sha2::{Digest, Sha256};
        let file = root.join(path);
        let modified = fs::metadata(&file)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let digest = Sha256::digest(fs::read(&file).unwrap())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Unchanged {
            path: path.into(),
            modified,
            digest,
        }
    }

    /// A copy and its live file, each read, as the sync checks them before the Trash.
    fn copy_and_live() -> (tempfile::TempDir, Vec<Unchanged>) {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("copy.md"), "---\na: 1\n---\n").unwrap();
        fs::write(vault.path().join("live.md"), "---\na: 1\nb: 2\n---\n").unwrap();
        let read = vec![
            as_read(vault.path(), "copy.md"),
            as_read(vault.path(), "live.md"),
        ];
        (vault, read)
    }

    #[test]
    fn trashes_when_every_file_named_is_as_it_was_read() {
        let (vault, read) = copy_and_live();
        let bin = tempdir().unwrap();
        trash_entry_at_unless_changed(vault.path(), "copy.md", &read, into(bin.path())).unwrap();
        assert!(!vault.path().join("copy.md").exists());
        assert!(bin.path().join("copy.md").exists());
    }

    #[test]
    fn refuses_when_the_entry_or_its_live_file_changed_since_it_was_read() {
        // Each change: the copy's bytes with its time put back, so only the digest
        // tells; its time alone; the live file's bytes; the live file gone.
        let changes: [fn(&Path, &[Unchanged]); 4] = [
            |root, read| {
                fs::write(root.join("copy.md"), "---\na: 2\n---\n").unwrap();
                let then =
                    std::time::UNIX_EPOCH + std::time::Duration::from_millis(read[0].modified);
                let file = fs::File::options()
                    .write(true)
                    .open(root.join("copy.md"))
                    .unwrap();
                file.set_modified(then).unwrap();
            },
            |root, _| {
                let later = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
                let file = fs::File::options()
                    .write(true)
                    .open(root.join("copy.md"))
                    .unwrap();
                file.set_modified(later).unwrap();
            },
            |root, _| fs::write(root.join("live.md"), "---\na: 1\n---\n").unwrap(),
            |root, _| fs::remove_file(root.join("live.md")).unwrap(),
        ];
        for change in changes {
            let (vault, read) = copy_and_live();
            change(vault.path(), &read);
            let error = trash_entry_at_unless_changed(vault.path(), "copy.md", &read, |_| {
                panic!("the Trash must not be asked")
            })
            .unwrap_err();
            assert_eq!(error, CHANGED_SINCE_READ);
            assert!(vault.path().join("copy.md").exists());
        }
    }

    #[test]
    fn refuses_a_named_file_outside_the_vault_without_asking_the_trash() {
        let (vault, mut read) = copy_and_live();
        read[1].path = "../live.md".into();
        assert!(
            trash_entry_at_unless_changed(vault.path(), "copy.md", &read, |_| {
                panic!("the Trash must not be asked")
            })
            .is_err()
        );
        assert!(vault.path().join("copy.md").exists());
    }

    /// The real Trash, once, by hand: it leaves a file in the Trash of whoever
    /// runs it, so it is not part of the gate. `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn the_system_trash_takes_a_note() {
        let vault = tempdir().unwrap();
        fs::write(vault.path().join("atlas-trash-check.md"), "x").unwrap();
        trash_entry_at(vault.path(), "atlas-trash-check.md", super::system_trash).unwrap();
        assert!(!vault.path().join("atlas-trash-check.md").exists());
    }
}
