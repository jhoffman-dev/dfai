//! Second attack on PR #684 (#680): what 3811cafa added — links judged as the
//! disk spells them, the walk that skips vanished entries and refuses on an
//! unreadable folder, and the narrower case-only rename — against real links
//! in real temporary folders.
//!
//! Tests marked `#[ignore = "bug: ..."]` are findings: run them with
//! `cargo test move_link_attack2_684 -- --ignored` to see them fail.

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::Path;

use tempfile::tempdir;

use crate::vault_entries::{entries_of, move_entry_at, refuse_retargeted_links};

const NFD_NAME: &str = "Cafe\u{301}.md";
const NFC_NAME: &str = "Caf\u{e9}.md";

/// Whether `dir`'s disk finds a name in another Unicode form (APFS does).
fn ignores_normalization(dir: &Path) -> bool {
    fs::write(dir.join(NFD_NAME), "").unwrap();
    let ignores = dir.join(NFC_NAME).exists();
    fs::remove_file(dir.join(NFD_NAME)).unwrap();
    ignores
}

/// Whether `dir`'s disk finds a name in another case (APFS's default).
fn ignores_case(dir: &Path) -> bool {
    fs::write(dir.join("CaseProbe"), "").unwrap();
    let ignores = dir.join("caseprobe").exists();
    fs::remove_file(dir.join("CaseProbe")).unwrap();
    ignores
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

// --- Names the case-only check does not take as case-only (held) -----------

/// The case-only check compares names by `to_lowercase`, so a name that differs
/// only in its Unicode form (a decomposed `é` from a zip or a Linux sync,
/// renamed to the composed one the keyboard types) goes the exclusive way.
/// APFS's exclusive rename takes it as a rename of the one entry, so it lands.
#[test]
fn a_rename_to_the_same_name_in_another_unicode_form_is_a_rename() {
    let vault = tempdir().unwrap();
    if !ignores_normalization(vault.path()) {
        return;
    }
    fs::write(vault.path().join(NFD_NAME), "note").unwrap();

    let renamed = move_entry_at(vault.path(), NFD_NAME, NFC_NAME);

    assert_eq!(renamed, Ok(()));
    assert_eq!(names_in(vault.path()), vec![NFC_NAME.to_string()]);
}

/// Rust's `to_lowercase` makes a word-final capital sigma `ς`, while APFS folds
/// `Σ`, `σ` and `ς` together. `οδοσ.md` to `ΟΔΟΣ.md` is one entry to the disk
/// but two names to the check; the exclusive rename lands it all the same.
#[test]
fn a_case_only_rename_ending_in_sigma_is_a_rename() {
    let vault = tempdir().unwrap();
    if !ignores_case(vault.path()) {
        return;
    }
    fs::write(vault.path().join("οδοσ.md"), "note").unwrap();
    if !vault.path().join("ΟΔΟΣ.md").exists() {
        return; // This disk does not fold the sigmas together.
    }

    let renamed = move_entry_at(vault.path(), "οδοσ.md", "ΟΔΟΣ.md");

    assert_eq!(renamed, Ok(()));
    assert_eq!(names_in(vault.path()), vec!["ΟΔΟΣ.md".to_string()]);
}

// --- Findings ---------------------------------------------------------------

/// `notes.md -> current/notes.md`, `current -> v3`: both inside the folder, and
/// both point at the same note wherever the folder goes. But the link's
/// target is spelled with `current` followed before the move (`v3/notes.md`)
/// and by name after it (`current/notes.md`, under a folder that does not
/// exist yet), so the two never match and the move is refused.
#[test]
#[ignore = "a safe refusal, left on review of PR #684: a link through another link in the folder is spelled through it before the move and by name after, so the two are not matched; matching them means simulating the link inside the moved tree"]
fn a_link_through_a_link_inside_the_folder_lets_the_folder_move() {
    let vault = tempdir().unwrap();
    fs::create_dir_all(vault.path().join("Projects/v3")).unwrap();
    fs::write(vault.path().join("Projects/v3/notes.md"), "notes").unwrap();
    fs::create_dir_all(vault.path().join("Play")).unwrap();
    symlink("v3", vault.path().join("Projects/current")).unwrap();
    symlink("current/notes.md", vault.path().join("Projects/notes.md")).unwrap();

    let moved = move_entry_at(vault.path(), "Projects", "Play/Projects");

    assert_eq!(moved, Ok(()));
    assert_eq!(
        fs::read_to_string(vault.path().join("Play/Projects/notes.md")).unwrap(),
        "notes"
    );
}

/// A link that pointed at nothing — `../Plans2/x.md` — still says "keeps
/// pointing" when renaming its own folder to `Plans2` makes it point at the
/// moved `x.md`: the expected target is worked out from a dangling path that
/// is not inside the source, so it is taken as unchanged.
#[test]
fn a_dangling_link_is_not_brought_to_point_at_a_moved_note() {
    let vault = tempdir().unwrap();
    fs::create_dir_all(vault.path().join("Plans")).unwrap();
    fs::write(vault.path().join("Plans/x.md"), "x").unwrap();
    symlink("../Plans2/x.md", vault.path().join("Plans/elsewhere.md")).unwrap();
    assert!(fs::metadata(vault.path().join("Plans/elsewhere.md")).is_err());

    let moved = move_entry_at(vault.path(), "Plans", "Plans2");

    assert!(
        moved.is_err() || fs::metadata(vault.path().join("Plans2/elsewhere.md")).is_err(),
        "the move made a link that reached nothing point at a note"
    );
}

/// A carried link that names the moved folder in another case
/// (`Projects/up -> ../projects/plan.md`, real folder `Projects`) reaches the
/// same note after the move on a case-insensitive disk, but the target's new
/// spelling under a folder not made yet is compared by name and differs.
#[test]
#[ignore = "a safe refusal, left on review of PR #684: where the link lands under the folder not made yet can only be compared by name, and a case-blind match would let through a re-pointed link on a disk that keeps case apart"]
fn a_link_naming_its_folder_in_another_case_lets_it_move() {
    let vault = tempdir().unwrap();
    if !ignores_case(vault.path()) {
        return;
    }
    fs::create_dir_all(vault.path().join("Projects")).unwrap();
    fs::write(vault.path().join("Projects/plan.md"), "plan").unwrap();
    fs::create_dir_all(vault.path().join("Play")).unwrap();
    symlink("../projects/plan.md", vault.path().join("Projects/up.md")).unwrap();

    let moved = move_entry_at(vault.path(), "Projects", "Play/Projects");

    assert_eq!(moved, Ok(()));
}

// --- Probes that held -------------------------------------------------------

#[test]
fn an_unreadable_file_inside_does_not_hold_the_move_up() {
    let vault = tempdir().unwrap();
    fs::create_dir_all(vault.path().join("Projects")).unwrap();
    fs::create_dir_all(vault.path().join("Play")).unwrap();
    let locked = vault.path().join("Projects/locked.md");
    fs::write(&locked, "secret").unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

    let moved = move_entry_at(vault.path(), "Projects", "Play/Projects");

    let landed = vault.path().join("Play/Projects/locked.md");
    let _ = fs::set_permissions(&landed, fs::Permissions::from_mode(0o644));
    assert_eq!(moved, Ok(()));
    assert!(landed.exists());
}

#[test]
fn an_unreadable_folder_inside_refuses_by_name_and_moves_nothing() {
    let vault = tempdir().unwrap();
    fs::create_dir_all(vault.path().join("Projects/Locked")).unwrap();
    fs::create_dir_all(vault.path().join("Play")).unwrap();
    let locked = vault.path().join("Projects/Locked");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

    let moved = move_entry_at(vault.path(), "Projects", "Play/Projects");

    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    let refusal = moved.unwrap_err();
    assert!(
        refusal.starts_with("cannot check the links inside Projects/Locked"),
        "{refusal}"
    );
    assert!(vault.path().join("Projects/Locked").exists());
    assert!(!vault.path().join("Play/Projects").exists());
}

/// The source gone before the walk: the walk finds nothing, and the rename
/// that follows must say so rather than the move reporting success.
#[test]
fn a_source_gone_before_the_walk_is_reported_not_moved_silently() {
    let vault = tempdir().unwrap();
    fs::create_dir_all(vault.path().join("Play")).unwrap();
    let source = vault.path().join("Projects");
    let target = vault.path().join("Play/Projects");

    assert_eq!(
        refuse_retargeted_links(vault.path(), &source, &target),
        Ok(())
    );
    let rename = crate::vault::rename_exclusive(&source, &target);
    assert!(rename.is_err(), "a rename of nothing reported success");
}

/// A folder replaced by a file between listing and reading is not a folder to
/// list: the walk says so, rather than taking it as empty.
#[test]
fn a_folder_turned_file_is_an_error_to_the_walk() {
    let vault = tempdir().unwrap();
    let now_a_file = vault.path().join("was-a-folder");
    fs::write(&now_a_file, "x").unwrap();

    assert!(entries_of(&now_a_file).is_err());
    assert_eq!(
        entries_of(&vault.path().join("gone")).unwrap(),
        Vec::<std::path::PathBuf>::new()
    );
}

#[test]
fn a_hard_link_in_another_folder_under_another_case_is_refused() {
    let vault = tempdir().unwrap();
    fs::create_dir_all(vault.path().join("A")).unwrap();
    fs::create_dir_all(vault.path().join("B")).unwrap();
    fs::write(vault.path().join("A/a.md"), "one").unwrap();
    fs::hard_link(vault.path().join("A/a.md"), vault.path().join("B/b.md")).unwrap();

    let moved = move_entry_at(vault.path(), "A/a.md", "B/B.md");

    if ignores_case(vault.path()) {
        assert!(moved.is_err());
        assert!(vault.path().join("A/a.md").exists());
    } else {
        assert_eq!(moved, Ok(()));
    }
    assert!(vault.path().join("B/b.md").exists());
}

#[test]
fn a_link_far_above_the_vault_root_keeps_pointing_when_moved_deeper() {
    let vault = tempdir().unwrap();
    fs::create_dir_all(vault.path().join("Projects")).unwrap();
    fs::create_dir_all(vault.path().join("Play/Deep")).unwrap();
    let ups = "../".repeat(64);
    symlink(format!("{ups}tmp"), vault.path().join("Projects/tmp")).unwrap();

    let moved = move_entry_at(vault.path(), "Projects", "Play/Deep/Projects");

    assert_eq!(moved, Ok(()));
}

#[test]
fn a_link_to_its_own_folder_moves_with_it() {
    let vault = tempdir().unwrap();
    fs::create_dir_all(vault.path().join("Projects")).unwrap();
    fs::create_dir_all(vault.path().join("Play/Deep")).unwrap();
    symlink(".", vault.path().join("Projects/here")).unwrap();
    symlink("../Projects", vault.path().join("Projects/self")).unwrap();

    assert_eq!(
        move_entry_at(vault.path(), "Projects", "Play/Projects"),
        Ok(())
    );
    assert!(fs::metadata(vault.path().join("Play/Projects/here")).is_ok());
    assert!(fs::metadata(vault.path().join("Play/Projects/self")).is_ok());
}

/// `Projects/up -> ../Hop/plan.md`, `Hop -> Shelf`: a link-of-a-link that leaves
/// the folder. Moved a level deeper it would reach `Play/Hop`, which is not
/// there; refused, the name given relative to the vault reached by a link.
#[test]
fn a_link_of_a_link_retargeted_by_the_move_is_refused_through_a_linked_vault() {
    let outer = tempdir().unwrap();
    let real = outer.path().join("real");
    fs::create_dir_all(real.join("Projects")).unwrap();
    fs::create_dir_all(real.join("Shelf")).unwrap();
    fs::create_dir_all(real.join("Play")).unwrap();
    fs::write(real.join("Shelf/plan.md"), "plan").unwrap();
    symlink("Shelf", real.join("Hop")).unwrap();
    symlink("../Hop/plan.md", real.join("Projects/up.md")).unwrap();
    let root = outer.path().join("Vault");
    symlink(&real, &root).unwrap();

    let moved = move_entry_at(&root, "Projects", "Play/Projects");

    assert_eq!(
        moved,
        Err("moving it would point a link elsewhere: Projects/up.md".into())
    );
    assert_eq!(
        fs::read_to_string(real.join("Projects/up.md")).unwrap(),
        "plan"
    );
}

/// A link whose name the TypeScript side cannot take as a vault path; see the
/// adapter attack for what the app makes of it.
#[test]
fn a_refused_link_is_named_as_it_is_spelled_even_with_a_backslash() {
    let vault = tempdir().unwrap();
    fs::create_dir_all(vault.path().join("Projects")).unwrap();
    fs::create_dir_all(vault.path().join("Shelf")).unwrap();
    fs::create_dir_all(vault.path().join("Play")).unwrap();
    symlink("../Shelf", vault.path().join("Projects/a\\b")).unwrap();

    let moved = move_entry_at(vault.path(), "Projects", "Play/Projects");

    assert_eq!(
        moved,
        Err("moving it would point a link elsewhere: Projects/a\\b".into())
    );
}

#[test]
fn a_very_deep_folder_still_moves() {
    let vault = tempdir().unwrap();
    let long = "n".repeat(200);
    let mut deep = vault.path().join("Projects");
    for _ in 0..4 {
        deep.push(&long);
    }
    fs::create_dir_all(&deep).unwrap();
    symlink("../../Shelf", deep.join("up")).unwrap();
    fs::create_dir_all(vault.path().join("Play")).unwrap();

    let moved = move_entry_at(vault.path(), "Projects", "Play/Projects");

    assert!(moved.is_ok(), "{moved:?}");
}
