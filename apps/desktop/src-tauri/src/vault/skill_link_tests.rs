//! A skill reached through a symlink (#169): every call the Skills page and
//! the skills API make — list `.atlas/skills`, list a skill's folder, read,
//! save and create its SKILL.md, create its folder, trash it — against real
//! links on a real disk.
//!
//! None of these is a skills-only rule. They hold because every one of those
//! calls goes through `resolve`, `resolve_new` or `resolve_entry`, which
//! refuse a path whose links land outside the vault, or in a hidden folder
//! the path did not name. A link that stays inside the vault is followed, as
//! it is for any note.

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use tempfile::{tempdir, TempDir};

use super::{create_note_at, list_entries, read_text, write_text, BasedOn};
use crate::vault_entries::{create_folder_at, trash_entry_at};

const OUTSIDE_TEXT: &str = "---\nname: elsewhere\n---\nNot the vault's.\n";
const ESCAPES: &str = "path escapes the vault";
const HIDDEN_DETOUR: &str = "path reaches a hidden folder through a link";

/// A vault with one real skill, and a folder outside it holding a SKILL.md.
struct Fixture {
    vault: TempDir,
    outside: TempDir,
}

impl Fixture {
    fn new() -> Self {
        let fixture = Fixture {
            vault: tempdir().unwrap(),
            outside: tempdir().unwrap(),
        };
        fs::create_dir_all(fixture.skills().join("real")).unwrap();
        fs::write(fixture.skills().join("real/SKILL.md"), "real").unwrap();
        fs::write(fixture.outside.path().join("SKILL.md"), OUTSIDE_TEXT).unwrap();
        fixture
    }

    fn root(&self) -> &Path {
        self.vault.path()
    }

    fn skills(&self) -> PathBuf {
        self.vault.path().join(".atlas/skills")
    }

    fn outside(&self, name: &str) -> PathBuf {
        self.outside.path().join(name)
    }

    /// The outside folder is exactly as the fixture made it: one SKILL.md, untouched.
    fn assert_outside_untouched(&self) {
        let names: Vec<_> = fs::read_dir(self.outside.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["SKILL.md"]);
        assert_eq!(
            fs::read_to_string(self.outside("SKILL.md")).unwrap(),
            OUTSIDE_TEXT
        );
    }
}

fn names_in(root: &Path, folder: &str) -> Vec<String> {
    let mut names: Vec<_> = list_entries(root, folder)
        .unwrap()
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    names.sort();
    names
}

fn read_error(root: &Path, path: &str) -> String {
    read_text(root, path).map(|_| ()).unwrap_err()
}

#[test]
fn a_skill_md_linked_outside_is_listed_but_never_read_or_written() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.skills().join("linked")).unwrap();
    symlink(
        fixture.outside("SKILL.md"),
        fixture.skills().join("linked/SKILL.md"),
    )
    .unwrap();
    let path = ".atlas/skills/linked/SKILL.md";

    // Listed, so the Skills page shows it as a SKILL.md it cannot read.
    assert_eq!(
        names_in(fixture.root(), ".atlas/skills/linked"),
        ["SKILL.md"]
    );
    assert_eq!(read_error(fixture.root(), path), ESCAPES);
    assert_eq!(
        write_text(fixture.root(), path, "overwritten", BasedOn::ANY).unwrap_err(),
        ESCAPES
    );
    assert_eq!(
        create_note_at(fixture.root(), path, "overwritten").unwrap_err(),
        "a note with that name already exists"
    );
    fixture.assert_outside_untouched();
}

#[test]
fn a_skill_folder_linked_outside_is_never_read_into_or_written_into() {
    let fixture = Fixture::new();
    symlink(fixture.outside.path(), fixture.skills().join("linked")).unwrap();
    let path = ".atlas/skills/linked/SKILL.md";

    assert_eq!(
        names_in(fixture.root(), ".atlas/skills"),
        ["linked", "real"]
    );
    assert_eq!(
        list_entries(fixture.root(), ".atlas/skills/linked")
            .map(|_| ())
            .unwrap_err(),
        ESCAPES
    );
    assert_eq!(read_error(fixture.root(), path), ESCAPES);
    assert_eq!(
        write_text(fixture.root(), path, "overwritten", BasedOn::ANY).unwrap_err(),
        ESCAPES
    );
    assert_eq!(
        create_note_at(fixture.root(), ".atlas/skills/linked/NEW.md", "x").unwrap_err(),
        ESCAPES
    );
    assert_eq!(
        create_folder_at(fixture.root(), ".atlas/skills/linked/scripts").unwrap_err(),
        ESCAPES
    );
    fixture.assert_outside_untouched();
}

#[test]
fn deleting_a_skill_folder_linked_outside_trashes_the_link_not_its_target() {
    let fixture = Fixture::new();
    let link = fixture.skills().join("linked");
    symlink(fixture.outside.path(), &link).unwrap();

    let mut trashed = None;
    trash_entry_at(fixture.root(), ".atlas/skills/linked", |entry| {
        trashed = Some(entry.to_path_buf());
        Ok(())
    })
    .unwrap();

    let trashed = trashed.expect("the Trash was asked");
    assert_eq!(trashed.file_name(), link.file_name());
    assert!(fs::symlink_metadata(&trashed).unwrap().is_symlink());
    assert!(trashed.starts_with(fixture.root().canonicalize().unwrap()));
    fixture.assert_outside_untouched();
}

#[test]
fn a_linked_skills_folder_or_atlas_folder_outside_is_refused_whole() {
    for linked in [".atlas/skills", ".atlas"] {
        let fixture = Fixture::new();
        let at = fixture.root().join(linked);
        fs::remove_dir_all(&at).unwrap();
        symlink(fixture.outside.path(), &at).unwrap();
        let skill = format!("{linked}/SKILL.md");

        assert_eq!(
            list_entries(fixture.root(), linked)
                .map(|_| ())
                .unwrap_err(),
            ESCAPES,
            "{linked}"
        );
        assert_eq!(read_error(fixture.root(), &skill), ESCAPES, "{linked}");
        assert_eq!(
            write_text(fixture.root(), &skill, "overwritten", BasedOn::ANY).unwrap_err(),
            ESCAPES,
            "{linked}"
        );
        assert_eq!(
            create_folder_at(fixture.root(), &format!("{linked}/new")).unwrap_err(),
            ESCAPES,
            "{linked}"
        );
        fixture.assert_outside_untouched();
    }
}

#[test]
fn a_dangling_skill_md_pointing_outside_is_not_created_through() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.skills().join("dangling")).unwrap();
    symlink(
        fixture.outside("NEW.md"),
        fixture.skills().join("dangling/SKILL.md"),
    )
    .unwrap();
    let path = ".atlas/skills/dangling/SKILL.md";

    // A broken link is skipped by a listing, so the skill reads as having no SKILL.md…
    assert!(names_in(fixture.root(), ".atlas/skills/dangling").is_empty());
    assert!(read_error(fixture.root(), path).starts_with("no such entry"));
    assert!(write_text(fixture.root(), path, "x", BasedOn::ANY)
        .unwrap_err()
        .starts_with("no such entry"));
    // …and writing one in its place leaves the link as it is rather than following it.
    assert_eq!(
        create_note_at(fixture.root(), path, "x").unwrap_err(),
        "a note with that name already exists"
    );
    fixture.assert_outside_untouched();
}

#[test]
fn a_dangling_skill_folder_is_left_out_of_the_list() {
    let fixture = Fixture::new();
    symlink(fixture.outside("gone"), fixture.skills().join("dangling")).unwrap();

    assert_eq!(names_in(fixture.root(), ".atlas/skills"), ["real"]);
    assert_eq!(
        create_note_at(fixture.root(), ".atlas/skills/dangling/SKILL.md", "x").unwrap_err(),
        "that folder does not exist"
    );
    fixture.assert_outside_untouched();
}

#[test]
fn a_skill_linked_to_another_skill_in_the_vault_reads_and_saves_that_one() {
    let fixture = Fixture::new();
    symlink(
        fixture.skills().join("real"),
        fixture.skills().join("alias"),
    )
    .unwrap();
    let path = ".atlas/skills/alias/SKILL.md";

    assert_eq!(read_text(fixture.root(), path).unwrap().text, "real");
    write_text(fixture.root(), path, "saved", BasedOn::ANY).unwrap();

    assert_eq!(
        fs::read_to_string(fixture.skills().join("real/SKILL.md")).unwrap(),
        "saved"
    );
    assert!(fs::symlink_metadata(fixture.skills().join("alias"))
        .unwrap()
        .is_symlink());
}

#[test]
fn a_skill_linked_into_another_hidden_folder_is_refused() {
    let fixture = Fixture::new();
    // `.git` is refused for being git's too; the detour is what is found first.
    for hidden in [".obsidian", ".git"] {
        let folder = fixture.root().join(hidden).join("plugin");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("SKILL.md"), "hidden").unwrap();
        symlink(&folder, fixture.skills().join(format!("via{hidden}"))).unwrap();
        let path = format!(".atlas/skills/via{hidden}/SKILL.md");

        assert_eq!(read_error(fixture.root(), &path), HIDDEN_DETOUR, "{hidden}");
        assert_eq!(
            write_text(fixture.root(), &path, "x", BasedOn::ANY).unwrap_err(),
            HIDDEN_DETOUR,
            "{hidden}"
        );
        assert_eq!(
            fs::read_to_string(folder.join("SKILL.md")).unwrap(),
            "hidden"
        );
    }
}
