//! Moving or renaming an entry that is, holds, or is reached through a link
//! (#680), against real links in real temporary folders.
//!
//! A move renames one entry, so a link moves as the link and a folder moves
//! whole with the links in it. What must not happen is a move that changes
//! what a link points at, or one made through a link, which would move the
//! entry behind it while the app believes it moved another path. Both are
//! refused before anything is touched.

use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;

use tempfile::tempdir;

use super::move_entry_at;

fn link_target(path: &Path) -> std::path::PathBuf {
    assert!(
        fs::symlink_metadata(path).unwrap().file_type().is_symlink(),
        "{} should be a link",
        path.display()
    );
    fs::read_link(path).unwrap()
}

/// `Shelf/Plans/garden.md`, a real folder and note the links point at.
fn vault_with_shelf() -> tempfile::TempDir {
    let vault = tempdir().unwrap();
    fs::create_dir_all(vault.path().join("Shelf/Plans")).unwrap();
    fs::write(vault.path().join("Shelf/Plans/garden.md"), "real").unwrap();
    fs::create_dir_all(vault.path().join("Work")).unwrap();
    fs::create_dir_all(vault.path().join("Play/Deep")).unwrap();
    vault
}

#[test]
fn moving_a_folder_that_is_a_link_moves_the_link_and_not_what_it_points_at() {
    let vault = vault_with_shelf();
    let shelf = vault.path().join("Shelf").canonicalize().unwrap();
    symlink(&shelf, vault.path().join("Work/Alias")).unwrap();

    move_entry_at(vault.path(), "Work/Alias", "Play/Deep/Alias").unwrap();

    assert!(!vault.path().join("Work/Alias").exists());
    assert_eq!(link_target(&vault.path().join("Play/Deep/Alias")), shelf);
    assert_eq!(
        fs::read_to_string(vault.path().join("Shelf/Plans/garden.md")).unwrap(),
        "real"
    );
}

#[test]
fn renaming_a_folder_linked_out_of_the_vault_renames_the_link() {
    let vault = vault_with_shelf();
    let outside = tempdir().unwrap();
    fs::write(outside.path().join("theirs.md"), "theirs").unwrap();
    symlink(outside.path(), vault.path().join("Work/Out")).unwrap();

    move_entry_at(vault.path(), "Work/Out", "Work/Away").unwrap();

    assert_eq!(link_target(&vault.path().join("Work/Away")), outside.path());
    assert!(outside.path().join("theirs.md").is_file());
}

#[test]
fn renaming_a_relative_link_in_its_own_folder_keeps_it_pointing_at_the_same_place() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();

    move_entry_at(vault.path(), "Work/Alias", "Work/Renamed").unwrap();

    assert_eq!(
        link_target(&vault.path().join("Work/Renamed")),
        Path::new("../Shelf")
    );
    assert!(vault.path().join("Work/Renamed/Plans/garden.md").is_file());
}

/// `../Shelf` from `Play/Deep` is `Play/Shelf`: the link would point at
/// nothing, or at another folder of that name.
#[test]
fn refuses_to_move_a_relative_link_where_it_would_point_elsewhere() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();

    assert_eq!(
        move_entry_at(vault.path(), "Work/Alias", "Play/Deep/Alias").unwrap_err(),
        "moving it would point a link elsewhere: Work/Alias"
    );
    assert_eq!(
        link_target(&vault.path().join("Work/Alias")),
        Path::new("../Shelf")
    );
    assert!(!vault.path().join("Play/Deep/Alias").exists());
}

#[test]
fn a_folder_holding_a_link_out_of_the_vault_moves_whole_with_the_link_intact() {
    let vault = vault_with_shelf();
    let outside = tempdir().unwrap();
    fs::write(outside.path().join("theirs.md"), "theirs").unwrap();
    fs::create_dir(vault.path().join("Projects")).unwrap();
    fs::write(vault.path().join("Projects/plan.md"), "mine").unwrap();
    symlink(outside.path(), vault.path().join("Projects/Out")).unwrap();

    move_entry_at(vault.path(), "Projects", "Play/Deep/Projects").unwrap();

    let moved = vault.path().join("Play/Deep/Projects");
    assert_eq!(fs::read_to_string(moved.join("plan.md")).unwrap(), "mine");
    assert_eq!(link_target(&moved.join("Out")), outside.path());
    assert!(outside.path().join("theirs.md").is_file());
    assert!(!vault.path().join("Projects").exists());
}

/// A link to something inside the folder moves along with it and still finds it.
#[test]
fn a_folder_holding_a_relative_link_into_itself_moves_with_the_link_working() {
    let vault = vault_with_shelf();
    fs::create_dir_all(vault.path().join("Projects/v2")).unwrap();
    fs::write(vault.path().join("Projects/v2/plan.md"), "mine").unwrap();
    symlink("v2", vault.path().join("Projects/latest")).unwrap();

    move_entry_at(vault.path(), "Projects", "Play/Deep/Projects").unwrap();

    let moved = vault.path().join("Play/Deep/Projects");
    assert_eq!(link_target(&moved.join("latest")), Path::new("v2"));
    assert_eq!(
        fs::read_to_string(moved.join("latest/plan.md")).unwrap(),
        "mine"
    );
}

/// At another depth `../../Shelf` would climb somewhere else.
#[test]
fn refuses_to_move_a_folder_whose_relative_link_would_point_elsewhere() {
    let vault = vault_with_shelf();
    fs::create_dir_all(vault.path().join("Work/Projects")).unwrap();
    fs::write(vault.path().join("Work/Projects/plan.md"), "mine").unwrap();
    symlink("../../Shelf", vault.path().join("Work/Projects/shelf")).unwrap();

    assert_eq!(
        move_entry_at(vault.path(), "Work/Projects", "Projects").unwrap_err(),
        "moving it would point a link elsewhere: Work/Projects/shelf"
    );
    assert!(vault.path().join("Work/Projects/plan.md").is_file());
    assert!(vault
        .path()
        .join("Work/Projects/shelf/Plans/garden.md")
        .is_file());
    assert!(!vault.path().join("Projects").exists());
}

/// Renaming the folder a link climbs back into by name would leave it naming the old one.
#[test]
fn refuses_a_rename_that_leaves_a_link_naming_the_old_folder() {
    let vault = vault_with_shelf();
    fs::create_dir_all(vault.path().join("Projects/v2")).unwrap();
    symlink("../Projects/v2", vault.path().join("Projects/latest")).unwrap();

    assert_eq!(
        move_entry_at(vault.path(), "Projects", "Plans").unwrap_err(),
        "moving it would point a link elsewhere: Projects/latest"
    );
    assert!(vault.path().join("Projects/latest").exists());
}

/// The same depth: `../../Shelf` from `Play/Projects` is still `Shelf`.
#[test]
fn moves_a_folder_whose_relative_link_still_points_at_the_same_place() {
    let vault = vault_with_shelf();
    fs::create_dir_all(vault.path().join("Work/Projects")).unwrap();
    symlink("../../Shelf", vault.path().join("Work/Projects/shelf")).unwrap();

    move_entry_at(vault.path(), "Work/Projects", "Play/Projects").unwrap();

    assert!(vault
        .path()
        .join("Play/Projects/shelf/Plans/garden.md")
        .is_file());
}

/// An absolute link into the folder would be left pointing at where it was.
#[test]
fn refuses_to_move_a_folder_holding_an_absolute_link_into_itself() {
    let vault = vault_with_shelf();
    fs::create_dir_all(vault.path().join("Projects/v2")).unwrap();
    let v2 = vault.path().join("Projects/v2").canonicalize().unwrap();
    symlink(&v2, vault.path().join("Projects/latest")).unwrap();

    assert_eq!(
        move_entry_at(vault.path(), "Projects", "Play/Projects").unwrap_err(),
        "moving it would point a link elsewhere: Projects/latest"
    );
    assert!(v2.is_dir());
}

/// The folder named in another case than the disk keeps is still the folder
/// the link points into (review of PR #684).
#[cfg(target_os = "macos")]
#[test]
fn refuses_to_move_a_folder_named_in_another_case_holding_an_absolute_link_into_it() {
    let vault = vault_with_shelf();
    fs::create_dir_all(vault.path().join("Projects/v2")).unwrap();
    let v2 = vault.path().join("Projects/v2").canonicalize().unwrap();
    symlink(&v2, vault.path().join("Projects/latest")).unwrap();

    assert_eq!(
        move_entry_at(vault.path(), "projects", "Play/projects").unwrap_err(),
        "moving it would point a link elsewhere: Projects/latest"
    );
    assert!(vault.path().join("Projects/latest").is_dir());
}

/// On a disk that ignores case, `../Projects/v2` still finds `projects/v2`,
/// so a case-only rename is made even though the link names the old spelling.
#[cfg(target_os = "macos")]
#[test]
fn a_case_only_rename_of_a_folder_holding_a_link_by_its_name_is_made() {
    let vault = vault_with_shelf();
    fs::create_dir_all(vault.path().join("Projects/v2")).unwrap();
    fs::write(vault.path().join("Projects/v2/plan.md"), "mine").unwrap();
    symlink("../Projects/v2", vault.path().join("Projects/latest")).unwrap();

    move_entry_at(vault.path(), "Projects", "projects").unwrap();

    assert_eq!(
        fs::read_to_string(vault.path().join("projects/latest/plan.md")).unwrap(),
        "mine"
    );
}

/// `Work/Alias/Plans` is `Shelf/Plans`: a move by the alias would move the
/// real folder while the app believes it moved another path (#680).
#[test]
fn refuses_to_move_an_entry_reached_through_a_link() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();

    assert_eq!(
        move_entry_at(vault.path(), "Work/Alias/Plans", "Work/Alias/Plans 2").unwrap_err(),
        "path goes through a link: Work/Alias"
    );
    assert_eq!(
        move_entry_at(vault.path(), "Work/Alias/Plans/garden.md", "Play/garden.md").unwrap_err(),
        "path goes through a link: Work/Alias"
    );
    assert!(vault.path().join("Shelf/Plans/garden.md").is_file());
    assert!(!vault.path().join("Shelf/Plans 2").exists());
    assert!(!vault.path().join("Play/garden.md").exists());
}

/// A move into a folder by a link lands where the link points, which the path
/// by the link still reaches: nothing is lost, so it is not refused.
#[test]
fn a_move_into_a_folder_reached_through_a_link_lands_where_the_link_points() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();
    fs::write(vault.path().join("note.md"), "mine").unwrap();

    move_entry_at(vault.path(), "note.md", "Work/Alias/Plans/note.md").unwrap();

    assert_eq!(
        fs::read_to_string(vault.path().join("Work/Alias/Plans/note.md")).unwrap(),
        "mine"
    );
    assert!(vault.path().join("Shelf/Plans/note.md").is_file());
    assert!(!vault.path().join("note.md").exists());
}

/// A link pointing at nothing would start pointing at whatever has that name
/// where it lands, so it is judged like any other.
#[test]
fn refuses_to_move_a_broken_relative_link_to_another_depth() {
    let vault = vault_with_shelf();
    symlink("../Nowhere", vault.path().join("Work/gone")).unwrap();

    assert_eq!(
        move_entry_at(vault.path(), "Work/gone", "Play/Deep/gone").unwrap_err(),
        "moving it would point a link elsewhere: Work/gone"
    );
    assert!(fs::symlink_metadata(vault.path().join("Work/gone")).is_ok());
}

/// On a disk that keeps case apart, `../Projects/v2` would not find
/// `projects/v2`: the same rename that is made on macOS is refused.
#[cfg(not(target_os = "macos"))]
#[test]
fn a_case_only_rename_that_would_lose_a_link_by_its_name_is_refused_where_case_matters() {
    let vault = vault_with_shelf();
    fs::create_dir_all(vault.path().join("Projects/v2")).unwrap();
    symlink("../Projects/v2", vault.path().join("Projects/latest")).unwrap();

    assert_eq!(
        move_entry_at(vault.path(), "Projects", "projects").unwrap_err(),
        "moving it would point a link elsewhere: Projects/latest"
    );
    assert!(vault.path().join("Projects/latest/").is_dir());
}

/// A name that went away between its folder being read and being looked at
/// has nothing to re-point; an unreadable folder is said, by name.
#[test]
fn the_link_check_passes_over_what_is_gone_and_names_what_it_cannot_read() {
    let vault = vault_with_shelf();
    let gone = vault.path().join("Shelf/gone");

    assert_eq!(
        super::refuse_retargeted_links(vault.path(), &gone, &vault.path().join("Play/gone")),
        Ok(())
    );
    assert_eq!(
        super::entries_of(&gone).unwrap(),
        Vec::<std::path::PathBuf>::new()
    );
    let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
    assert_eq!(
        super::cannot_check("Shelf/Locked", &denied),
        "cannot check the links inside Shelf/Locked: permission denied"
    );
}

#[path = "move_link_attack_684_tests.rs"]
mod attack_684;
