//! Attack on PR #684 (#680): moves that are, carry, or are reached through a
//! link, against real links in real temporary folders.
//!
//! Tests marked `#[ignore = "bug: ..."]` are findings: run them with
//! `cargo test move_link_attack_684 -- --ignored` to see them fail.

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};

use tempfile::tempdir;

use crate::vault_entries::move_entry_at;

/// `Shelf/Plans/garden.md`, `Work`, `Play/Deep`.
fn vault_with_shelf() -> tempfile::TempDir {
    let vault = tempdir().unwrap();
    fs::create_dir_all(vault.path().join("Shelf/Plans")).unwrap();
    fs::write(vault.path().join("Shelf/Plans/garden.md"), "real").unwrap();
    fs::create_dir_all(vault.path().join("Work")).unwrap();
    fs::create_dir_all(vault.path().join("Play/Deep")).unwrap();
    vault
}

/// Whether `dir`'s disk finds a name in another case (APFS's default).
fn ignores_case(dir: &Path) -> bool {
    fs::write(dir.join("CaseProbe"), "").unwrap();
    let ignores = dir.join("caseprobe").exists();
    fs::remove_file(dir.join("CaseProbe")).unwrap();
    ignores
}

/// Whether every link under `dir` still reaches something, not following
/// links into folders (a link loop would never end).
fn dangling_links(dir: &Path) -> Vec<PathBuf> {
    let mut dangling = Vec::new();
    let mut waiting = vec![dir.to_path_buf()];
    while let Some(at) = waiting.pop() {
        let metadata = fs::symlink_metadata(&at).unwrap();
        if metadata.file_type().is_symlink() {
            if fs::metadata(&at).is_err() {
                dangling.push(at);
            }
        } else if metadata.is_dir() {
            for entry in fs::read_dir(&at).unwrap() {
                waiting.push(entry.unwrap().path());
            }
        }
    }
    dangling
}

// --- Findings ---------------------------------------------------------------

/// The vault as the app was given it may be reached through a link (`~/Dropbox`
/// is one to `~/Library/CloudStorage/Dropbox`; a temp folder on macOS is under
/// `/var`, a link to `/private/var`). An absolute link made by that spelling
/// into the moved folder is compared against the canonical source, does not
/// match, and so is taken as pointing outside: the move goes ahead and the
/// link is left pointing at where the folder was.
#[test]
#[ignore = "bug: absolute link into the moved folder spelled by the vault's non-canonical root is not seen, move dangles it (PR #684)"]
fn an_absolute_link_into_the_folder_by_the_vaults_own_spelling_never_dangles() {
    let outer = tempdir().unwrap();
    let real = outer.path().join("real");
    fs::create_dir_all(real.join("Projects/v2")).unwrap();
    fs::write(real.join("Projects/v2/plan.md"), "plan").unwrap();
    fs::create_dir_all(real.join("Play")).unwrap();
    let root = outer.path().join("Vault");
    symlink(&real, &root).unwrap();
    symlink(root.join("Projects/v2"), root.join("Projects/latest")).unwrap();

    let moved = move_entry_at(&root, "Projects", "Play/Projects");

    let dangling = dangling_links(&real);
    assert!(
        moved.is_err() || dangling.is_empty(),
        "move went ahead and left {dangling:?} pointing at nothing"
    );
}

/// The same gap by case: on a disk that ignores case, `/…/projects/v2` is the
/// folder's own `v2`, but is not a prefix match for `/…/Projects`.
#[test]
#[ignore = "bug: absolute link into the moved folder in another case is not seen, move dangles it (PR #684)"]
fn an_absolute_link_into_the_folder_in_another_case_never_dangles() {
    let vault = tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    if !ignores_case(&root) {
        return; // Only a case-insensitive disk resolves the other spelling.
    }
    fs::create_dir_all(root.join("Projects/v2")).unwrap();
    fs::create_dir_all(root.join("Play")).unwrap();
    symlink(root.join("projects/v2"), root.join("Projects/latest")).unwrap();
    assert!(
        root.join("Projects/latest").is_dir(),
        "precondition: link works"
    );

    let moved = move_entry_at(&root, "Projects", "Play/Projects");

    let dangling = dangling_links(&root);
    assert!(
        moved.is_err() || dangling.is_empty(),
        "move went ahead and left {dangling:?} pointing at nothing"
    );
}

/// The same gap by Unicode form: APFS finds `Café` (NFC) by `Café` (NFD).
#[test]
#[ignore = "bug: absolute link into the moved folder in the other Unicode form is not seen, move dangles it (PR #684)"]
fn an_absolute_link_into_the_folder_in_another_unicode_form_never_dangles() {
    let vault = tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    let nfc = "Caf\u{e9}";
    let nfd = "Cafe\u{301}";
    fs::create_dir_all(root.join(nfc).join("v2")).unwrap();
    fs::create_dir_all(root.join("Play")).unwrap();
    if !root.join(nfd).is_dir() {
        return; // Only a normalisation-insensitive disk resolves the other form.
    }
    symlink(root.join(nfd).join("v2"), root.join(nfc).join("latest")).unwrap();

    let moved = move_entry_at(&root, nfc, &format!("Play/{nfc}"));

    let dangling = dangling_links(&root);
    assert!(
        moved.is_err() || dangling.is_empty(),
        "move went ahead and left {dangling:?} pointing at nothing"
    );
}

/// Only what the move carries is checked. A link elsewhere in the vault into
/// the moved folder — the very `Work/Alias -> ../Shelf` of #680, whose notes
/// the tree lists and panes may hold open — is left pointing at nothing.
#[test]
#[ignore = "bug: a link outside the moved folder into it is not checked, move dangles it (PR #684, design)"]
fn moving_the_folder_a_link_points_at_never_dangles_the_link() {
    let vault = vault_with_shelf();
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();

    let moved = move_entry_at(vault.path(), "Shelf", "Play/Deep/Shelf");

    let dangling = dangling_links(vault.path());
    assert!(
        moved.is_err() || dangling.is_empty(),
        "move went ahead and left {dangling:?} pointing at nothing"
    );
}

/// A move used to be one rename. The new walk reads every folder the move
/// carries, so one the user cannot list makes the whole move fail, though the
/// rename itself would succeed (it needs only the parent's permission).
#[test]
#[ignore = "bug: regression, a folder holding an unreadable subfolder can no longer be moved (PR #684)"]
fn a_folder_holding_an_unreadable_subfolder_still_moves() {
    let vault = vault_with_shelf();
    let locked = vault.path().join("Shelf/Locked");
    fs::create_dir_all(&locked).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

    let moved = move_entry_at(vault.path(), "Shelf", "Play/Shelf");

    let moved_locked = vault.path().join("Play/Shelf/Locked");
    let restore = if moved.is_ok() {
        &moved_locked
    } else {
        &locked
    };
    fs::set_permissions(restore, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(moved, Ok(()));
    assert!(vault.path().join("Play/Shelf/Plans/garden.md").is_file());
}

/// `a.md` and `b.md` are one file by two hard links. Moving `a.md` to `B.md`
/// on a case-insensitive disk is taken for a case-only rename and handed to a
/// plain rename, which between two names of one file does nothing and
/// succeeds: the app is told `a.md` is now `B.md` while both names stay.
#[test]
#[ignore = "bug: move onto a hard link's other name in another case reports success and moves nothing (pre-existing, case-only branch)"]
fn a_reported_move_onto_a_hard_links_other_name_leaves_no_source_behind() {
    let vault = tempdir().unwrap();
    let root = vault.path();
    if !ignores_case(root) {
        return;
    }
    fs::write(root.join("a.md"), "one").unwrap();
    fs::hard_link(root.join("a.md"), root.join("b.md")).unwrap();

    let moved = move_entry_at(root, "a.md", "B.md");

    assert!(
        moved.is_err() || !root.join("a.md").exists(),
        "move reported {moved:?} but a.md is still there"
    );
}

// --- Probed and sound -------------------------------------------------------

#[test]
fn a_link_loop_inside_the_moved_folder_is_carried_without_hanging() {
    let vault = vault_with_shelf();
    symlink("b", vault.path().join("Shelf/a")).unwrap();
    symlink("a", vault.path().join("Shelf/b")).unwrap();

    move_entry_at(vault.path(), "Shelf", "Play/Deep/Shelf").unwrap();

    assert_eq!(
        fs::read_link(vault.path().join("Play/Deep/Shelf/a")).unwrap(),
        Path::new("b")
    );
    assert!(vault
        .path()
        .join("Play/Deep/Shelf/Plans/garden.md")
        .is_file());
}

#[test]
fn a_folder_linking_to_its_own_parent_is_refused_at_another_depth() {
    let vault = vault_with_shelf();
    symlink("..", vault.path().join("Shelf/up")).unwrap();

    assert!(move_entry_at(vault.path(), "Shelf", "Play/Deep/Shelf").is_err());
    assert!(vault.path().join("Shelf/Plans/garden.md").is_file());
}

#[test]
fn a_folder_linking_to_itself_moves_with_the_link_working() {
    let vault = vault_with_shelf();
    symlink(".", vault.path().join("Shelf/me")).unwrap();

    move_entry_at(vault.path(), "Shelf", "Play/Deep/Shelf").unwrap();

    assert!(vault
        .path()
        .join("Play/Deep/Shelf/me/Plans/garden.md")
        .is_file());
}

#[test]
fn a_dangling_relative_link_is_refused_where_it_could_start_pointing_at_something() {
    let vault = vault_with_shelf();
    symlink("../Nothing", vault.path().join("Shelf/gone")).unwrap();
    fs::create_dir_all(vault.path().join("Play/Nothing")).unwrap();

    assert!(move_entry_at(vault.path(), "Shelf", "Play/Shelf").is_err());
}

#[test]
fn a_link_that_leaves_the_vault_and_comes_back_is_judged_by_where_it_lands() {
    let vault = vault_with_shelf();
    let name = vault
        .path()
        .canonicalize()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    fs::create_dir_all(vault.path().join("Work/Projects")).unwrap();
    symlink(
        format!("../../../{name}/Shelf"),
        vault.path().join("Work/Projects/shelf"),
    )
    .unwrap();
    assert!(vault.path().join("Work/Projects/shelf/Plans").is_dir());

    // Same depth: still reaches Shelf, so it moves.
    move_entry_at(vault.path(), "Work/Projects", "Play/Projects").unwrap();
    assert!(vault.path().join("Play/Projects/shelf/Plans").is_dir());
    // Another depth: it would not, so it is refused.
    assert!(move_entry_at(vault.path(), "Play/Projects", "Play/Deep/Projects").is_err());
}

#[test]
fn a_move_into_its_own_descendant_by_a_link_is_refused() {
    let vault = vault_with_shelf();
    symlink("Shelf/Plans", vault.path().join("Door")).unwrap();

    assert!(move_entry_at(vault.path(), "Shelf", "Door/Shelf").is_err());
    assert!(vault.path().join("Shelf/Plans/garden.md").is_file());
}

#[test]
fn a_move_onto_an_existing_link_name_is_refused_and_nothing_is_replaced() {
    let vault = vault_with_shelf();
    fs::write(vault.path().join("note.md"), "mine").unwrap();
    symlink(
        "../Shelf/Plans/garden.md",
        vault.path().join("Work/note.md"),
    )
    .unwrap();

    assert!(move_entry_at(vault.path(), "note.md", "Work/note.md").is_err());
    assert_eq!(
        fs::read_to_string(vault.path().join("Work/note.md")).unwrap(),
        "real"
    );
    assert!(vault.path().join("note.md").is_file());
}

#[test]
fn a_move_whose_path_names_the_link_in_another_case_is_still_refused() {
    let vault = vault_with_shelf();
    if !ignores_case(vault.path()) {
        return;
    }
    symlink("../Shelf", vault.path().join("Work/Alias")).unwrap();

    assert!(move_entry_at(vault.path(), "work/alias/Plans", "work/alias/Plans 2").is_err());
    assert!(vault.path().join("Shelf/Plans/garden.md").is_file());
}

#[test]
fn a_file_link_to_a_note_is_refused_at_another_depth_and_allowed_at_the_same() {
    let vault = vault_with_shelf();
    fs::create_dir_all(vault.path().join("Work/Box")).unwrap();
    symlink(
        "../../Shelf/Plans/garden.md",
        vault.path().join("Work/Box/garden.md"),
    )
    .unwrap();

    assert!(move_entry_at(vault.path(), "Work/Box", "Box").is_err());
    move_entry_at(vault.path(), "Work/Box", "Play/Box").unwrap();
    assert_eq!(
        fs::read_to_string(vault.path().join("Play/Box/garden.md")).unwrap(),
        "real"
    );
}

#[test]
fn a_deep_tree_with_a_link_at_the_bottom_is_walked_to_the_bottom() {
    let vault = vault_with_shelf();
    let mut deep = vault.path().join("Tree");
    for level in 0..60 {
        deep.push(format!("l{level}"));
    }
    fs::create_dir_all(&deep).unwrap();
    let up = "../".repeat(61);
    symlink(format!("{up}Shelf"), deep.join("shelf")).unwrap();

    assert!(move_entry_at(vault.path(), "Tree", "Play/Tree").is_err());
    assert!(deep.join("shelf/Plans/garden.md").is_file());
}
