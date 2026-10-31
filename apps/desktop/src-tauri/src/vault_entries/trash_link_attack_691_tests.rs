//! Attack on PR #691 (#685): trashing through a link, against real links in
//! real temporary folders. The Trash is always the test's own closure: nothing
//! here reaches the system Trash.

use std::cell::Cell;
use std::ffi::CString;
use std::fs;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{symlink, OpenOptionsExt};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tempfile::tempdir;

use super::super::{trash_entry_at, trash_entry_at_unless_changed, Unchanged};

/// `Shelf/Plan.md` and `Shelf/Plans/garden.md` beside an empty `Work`.
fn vault_with_shelf() -> tempfile::TempDir {
    let vault = tempdir().unwrap();
    fs::create_dir_all(vault.path().join("Shelf/Plans")).unwrap();
    fs::write(vault.path().join("Shelf/Plan.md"), "real").unwrap();
    fs::write(vault.path().join("Shelf/Plans/garden.md"), "real").unwrap();
    fs::create_dir_all(vault.path().join("Work")).unwrap();
    vault
}

/// Trashes `path`, recording what the Trash was asked to take.
fn trash_recording(root: &Path, path: &str) -> (Result<(), String>, Option<PathBuf>) {
    let asked: Cell<Option<PathBuf>> = Cell::new(None);
    let result = trash_entry_at(root, path, |entry| {
        asked.set(Some(entry.to_path_buf()));
        Ok(())
    });
    (result, asked.take())
}

fn assert_refused_untouched(vault: &Path, path: &str) {
    let (result, asked) = trash_recording(vault, path);
    assert!(result.is_err(), "{path} was trashed: {asked:?}");
    assert!(asked.is_none(), "{path}: the Trash was asked for {asked:?}");
    assert!(vault.join("Shelf/Plan.md").is_file());
    assert!(vault.join("Shelf/Plans/garden.md").is_file());
}

fn modified_ms(path: &Path) -> u64 {
    fs::symlink_metadata(path)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn digest_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
fn a_link_folder_spelled_in_another_case_is_still_refused() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();

    assert_refused_untouched(vault.path(), "work/ALIAS/Plan.md");
}

#[test]
fn a_link_folder_spelled_in_the_other_unicode_form_is_still_refused() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Caf\u{e9}")).unwrap();

    assert_refused_untouched(vault.path(), "Work/Cafe\u{301}/Plan.md");
}

#[test]
fn a_link_to_a_link_is_refused() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Inner")).unwrap();
    symlink("Inner", vault.path().join("Work/Outer")).unwrap();

    assert_refused_untouched(vault.path(), "Work/Outer/Plan.md");
}

#[test]
fn a_path_through_a_link_cycle_is_refused_without_hanging() {
    let vault = vault_with_shelf();
    symlink("Loop", vault.path().join("Work/Loop")).unwrap();
    symlink("Ping", vault.path().join("Work/Pong")).unwrap();
    symlink("Pong", vault.path().join("Work/Ping")).unwrap();

    assert_refused_untouched(vault.path(), "Work/Loop/Plan.md");
    assert_refused_untouched(vault.path(), "Work/Ping/Plan.md");
}

#[test]
fn a_link_cycle_itself_is_trashed_as_the_link() {
    let vault = vault_with_shelf();
    symlink("Loop", vault.path().join("Work/Loop")).unwrap();

    let (result, asked) = trash_recording(vault.path(), "Work/Loop");

    result.unwrap();
    let asked = asked.unwrap();
    assert!(fs::symlink_metadata(&asked)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn a_dangling_link_in_the_parent_path_is_refused() {
    let vault = vault_with_shelf();
    symlink("../Nowhere", vault.path().join("Work/Gone")).unwrap();

    assert_refused_untouched(vault.path(), "Work/Gone/Plan.md");
}

#[test]
fn dot_segments_never_reach_the_trash() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();

    for path in [
        "Work/Alias/../Shelf/Plan.md",
        "Work/../Shelf/Plan.md",
        "Shelf/Plans/..",
        "Shelf/..",
        "Work/Alias/.",
        "./Work/Alias/Plan.md",
        "Shelf/./Plan.md",
    ] {
        assert_refused_untouched(vault.path(), path);
    }
}

#[test]
fn the_vault_root_is_never_trashed() {
    let vault = vault_with_shelf();

    for path in ["", "/", "//", "."] {
        assert_refused_untouched(vault.path(), path);
    }
    assert!(vault.path().is_dir());
}

#[test]
fn doubled_slashes_do_not_hide_a_link() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();

    assert_refused_untouched(vault.path(), "Work//Alias//Plan.md");
    assert_refused_untouched(vault.path(), "/Work/Alias/Plan.md");
}

/// With a trailing slash the OS follows a link (`Alias/` is the folder it points
/// at), so the Trash must be handed the link's own name, slash dropped.
#[test]
fn a_link_folder_with_a_trailing_slash_is_trashed_as_the_link() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();

    let (result, asked) = trash_recording(vault.path(), "Work/Alias/");

    result.unwrap();
    let asked = asked.unwrap();
    assert!(!asked.as_os_str().as_bytes().ends_with(b"/"), "{asked:?}");
    assert!(fs::symlink_metadata(&asked)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn a_note_link_inside_a_folder_link_is_refused() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();
    symlink("Plan.md", vault.path().join("Shelf/Pointer.md")).unwrap();

    assert_refused_untouched(vault.path(), "Work/Alias/Pointer.md");
    assert!(fs::symlink_metadata(vault.path().join("Shelf/Pointer.md")).is_ok());
}

#[test]
fn a_parent_link_out_of_the_vault_is_refused() {
    let vault = vault_with_shelf();
    let outside = tempdir().unwrap();
    fs::write(outside.path().join("Plan.md"), "outside").unwrap();
    symlink(outside.path(), vault.path().join("Work/Out")).unwrap();

    assert_refused_untouched(vault.path(), "Work/Out/Plan.md");
    assert!(outside.path().join("Plan.md").is_file());
}

/// A hard link is a name of its own: the Trash takes that name, and the other
/// stays with the bytes.
#[test]
fn a_hard_link_is_trashed_as_its_own_name_and_the_other_keeps_the_bytes() {
    let vault = vault_with_shelf();
    fs::hard_link(
        vault.path().join("Shelf/Plan.md"),
        vault.path().join("Work/hard.md"),
    )
    .unwrap();

    let result = trash_entry_at(vault.path(), "Work/hard.md", |entry| {
        assert_eq!(entry.file_name().unwrap(), "hard.md");
        fs::remove_file(entry).map_err(|error| error.to_string())
    });

    result.unwrap();
    assert_eq!(
        fs::read_to_string(vault.path().join("Shelf/Plan.md")).unwrap(),
        "real"
    );
}

/// The vault itself opened by way of a link (`~/Vault -> /Volumes/...`) is no
/// link *in* the vault: its notes still go.
#[test]
fn a_vault_opened_through_a_link_still_trashes_its_notes() {
    let real = vault_with_shelf();
    let holder = tempdir().unwrap();
    let opened = holder.path().join("Vault");
    symlink(real.path(), &opened).unwrap();
    fs::write(real.path().join("Work/own.md"), "mine").unwrap();

    let (result, asked) = trash_recording(&opened, "Work/own.md");

    result.unwrap();
    assert_eq!(asked.unwrap().file_name().unwrap(), "own.md");
}

/// A file to hold still may itself be read through a link: the comparison is of
/// the real file behind it, and a stale one still stops the trash.
#[test]
fn a_held_file_read_through_a_link_is_compared_as_the_file_behind_it() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();
    fs::write(vault.path().join("Work/own.md"), "mine").unwrap();
    let held = |digest: String| Unchanged {
        path: "Work/Alias/Plan.md".into(),
        modified: modified_ms(&vault.path().join("Shelf/Plan.md")),
        digest,
    };
    let asked = Cell::new(false);

    let stale = trash_entry_at_unless_changed(
        vault.path(),
        "Work/own.md",
        &[held(digest_of(b"other"))],
        |_| {
            asked.set(true);
            Ok(())
        },
    );
    assert_eq!(stale.unwrap_err(), super::super::CHANGED_SINCE_READ);
    assert!(!asked.get());

    trash_entry_at_unless_changed(
        vault.path(),
        "Work/own.md",
        &[held(digest_of(b"real"))],
        |_| {
            asked.set(true);
            Ok(())
        },
    )
    .unwrap();
    assert!(asked.get());
}

/// Sequenced, not timed: the file to hold still is a FIFO, so its comparison
/// waits on this test. While it waits — after the link check, before the path
/// is resolved for the Trash — a real `Work/Sub` is swapped for a link to
/// `Shelf`. The swap is made by another program (no change turn), which
/// `resolve`'s own docs put out of scope; but the check runs *before* the held
/// files are hashed (any size, any number) instead of on the path the Trash is
/// handed, so the window is as wide as that hashing, and it is cheap to close
/// (check the resolved parent, or check again after resolving).
#[test]
#[ignore = "bug: link check runs before the held files are hashed, not on the path handed to the Trash (#685 TOCTOU)"]
fn a_link_swapped_in_while_held_files_are_compared_is_not_followed_to_the_trash() {
    let vault = vault_with_shelf();
    fs::create_dir_all(vault.path().join("Work/Sub")).unwrap();
    fs::write(vault.path().join("Work/Sub/Plan.md"), "mine").unwrap();
    let pipe = vault.path().join("Work/pipe");
    let c_pipe = CString::new(pipe.as_os_str().as_bytes()).unwrap();
    // SAFETY: a valid NUL-terminated path; mkfifo touches nothing else.
    assert_eq!(unsafe { libc::mkfifo(c_pipe.as_ptr(), 0o600) }, 0);
    let held = Unchanged {
        path: "Work/pipe".into(),
        modified: modified_ms(&pipe),
        digest: digest_of(b"held"),
    };
    let work = vault.path().join("Work");
    let writer = {
        let (pipe, work) = (pipe.clone(), work.clone());
        std::thread::spawn(move || {
            // Opening blocks until the comparison opens the FIFO to hash it.
            let mut end = fs::OpenOptions::new().write(true).open(&pipe).unwrap();
            fs::rename(work.join("Sub"), work.join("SubOld")).unwrap();
            symlink("../Shelf", work.join("Sub")).unwrap();
            end.write_all(b"held").unwrap();
        })
    };
    let asked: Cell<Option<PathBuf>> = Cell::new(None);

    let result =
        trash_entry_at_unless_changed(vault.path(), "Work/Sub/Plan.md", &[held], |entry| {
            asked.set(Some(entry.to_path_buf()));
            Ok(())
        });
    // Unblocks the writer if the comparison never opened the FIFO.
    let _ = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&pipe);
    writer.join().unwrap();

    let shelf_plan = vault.path().join("Shelf/Plan.md").canonicalize().unwrap();
    let asked = asked.take();
    assert!(
        result.is_err() && asked.is_none(),
        "the Trash was asked for {asked:?} (the real Shelf/Plan.md is {shelf_plan:?})"
    );
}
