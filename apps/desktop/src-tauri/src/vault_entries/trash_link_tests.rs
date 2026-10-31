//! Trashing an entry that is, holds, or is reached through a link (#685),
//! against real links in real temporary folders.
//!
//! A trash takes one entry, so a link goes as the link and a folder goes whole
//! with the links in it. What must not happen is a trash made through a link,
//! which would throw away the real entry behind it while the caller believes
//! it threw away another path. That is refused before the Trash is asked.

use std::cell::Cell;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use tempfile::tempdir;

use super::{trash_entry_at, trash_entry_at_unless_changed, Unchanged};

/// `Shelf/Plan.md` and `Shelf/Plans/garden.md`, the real entries the links
/// point at, beside an empty `Work`.
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

#[test]
fn a_note_reached_through_a_folder_link_is_refused_naming_the_link() {
    let vault = vault_with_shelf();
    let shelf = vault.path().join("Shelf").canonicalize().unwrap();
    symlink(&shelf, vault.path().join("Work/Alias")).unwrap();

    let (result, asked) = trash_recording(vault.path(), "Work/Alias/Plan.md");

    assert_eq!(result.unwrap_err(), "path goes through a link: Work/Alias");
    assert!(asked.is_none(), "the Trash was asked for {asked:?}");
    assert!(vault.path().join("Shelf/Plan.md").is_file());
}

#[test]
fn a_folder_reached_through_a_relative_link_is_refused() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();

    let (result, asked) = trash_recording(vault.path(), "Work/Alias/Plans");

    assert_eq!(result.unwrap_err(), "path goes through a link: Work/Alias");
    assert!(asked.is_none(), "the Trash was asked for {asked:?}");
    assert!(vault.path().join("Shelf/Plans/garden.md").is_file());
}

/// The link named is the first one on the way, from the vault root, however
/// deep it sits and whatever comes after it.
#[test]
fn the_refusal_names_the_first_link_from_the_vault_root() {
    let vault = vault_with_shelf();
    fs::create_dir_all(vault.path().join("Work/Real")).unwrap();
    symlink("../../Shelf", vault.path().join("Work/Real/Alias")).unwrap();

    let (result, asked) = trash_recording(vault.path(), "Work/Real/Alias/Plans/garden.md");

    assert_eq!(
        result.unwrap_err(),
        "path goes through a link: Work/Real/Alias"
    );
    assert!(asked.is_none(), "the Trash was asked for {asked:?}");
    assert!(vault.path().join("Shelf/Plans/garden.md").is_file());
}

/// The link is named before the files to hold still are compared: a caller
/// whose copy is stale is told the real reason it cannot trash there, and
/// nothing is trashed.
#[test]
fn the_link_is_named_before_the_files_to_hold_still_are_compared() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();
    let stale = Unchanged {
        path: "Work/Alias/Plan.md".into(),
        modified: 0,
        digest: "not what it holds".into(),
    };
    let asked = Cell::new(false);

    let result =
        trash_entry_at_unless_changed(vault.path(), "Work/Alias/Plan.md", &[stale], |_| {
            asked.set(true);
            Ok(())
        });

    assert_eq!(result.unwrap_err(), "path goes through a link: Work/Alias");
    assert!(!asked.get(), "the Trash was asked");
    assert!(vault.path().join("Shelf/Plan.md").is_file());
}

/// PR #646: a folder that is a link is thrown away as the link, never what it
/// points at.
#[test]
fn a_folder_that_is_a_link_is_trashed_as_the_link() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();

    let (result, asked) = trash_recording(vault.path(), "Work/Alias");

    result.unwrap();
    let asked = asked.expect("the Trash was not asked");
    assert_eq!(asked.file_name().unwrap(), "Alias");
    assert!(fs::symlink_metadata(&asked)
        .unwrap()
        .file_type()
        .is_symlink());
}

/// A real folder holding a link goes whole: the link inside is no way through.
#[test]
fn a_real_folder_holding_a_link_is_trashed_whole() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();

    let (result, asked) = trash_recording(vault.path(), "Work");

    result.unwrap();
    assert_eq!(asked.unwrap().file_name().unwrap(), "Work");
}

/// A note in a real folder beside a link is no way through it either.
#[test]
fn a_note_beside_a_link_is_trashed() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();
    fs::write(vault.path().join("Work/own.md"), "mine").unwrap();

    let (result, asked) = trash_recording(vault.path(), "Work/own.md");

    result.unwrap();
    assert_eq!(asked.unwrap().file_name().unwrap(), "own.md");
}
