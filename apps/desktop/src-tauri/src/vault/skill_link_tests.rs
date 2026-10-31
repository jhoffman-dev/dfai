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
//!
//! The refusal is decided when the path is resolved, and the file is opened
//! by the path resolved: a local program that swaps a folder for a link in
//! between is out of scope, as it is for every note.

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
    // The refused create leaves no temporary behind.
    assert_eq!(
        names_in(fixture.root(), ".atlas/skills/linked"),
        ["SKILL.md"]
    );
    assert!(fs::symlink_metadata(fixture.skills().join("linked/.SKILL.md.atlas-tmp")).is_err());
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
fn deleting_a_skill_folder_linked_outside_hands_the_link_to_the_trash_not_its_target() {
    let fixture = Fixture::new();
    let link = fixture.skills().join("linked");
    symlink(fixture.outside.path(), &link).unwrap();

    let mut trashed = None;
    trash_entry_at(fixture.root(), ".atlas/skills/linked", |entry| {
        trashed = Some(entry.to_path_buf());
        Ok(())
    })
    .unwrap();

    // The path handling's answer: what would go to the Trash is the link itself.
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

/// Each entry as the Skills page receives it, by name: whether it is a link.
fn links_in(root: &Path, folder: &str) -> Vec<(String, bool)> {
    let mut entries: Vec<_> = list_entries(root, folder)
        .unwrap()
        .into_iter()
        .map(|entry| {
            let sent = serde_json::to_value(&entry).unwrap();
            (entry.name, sent["link"] == serde_json::Value::Bool(true))
        })
        .collect();
    entries.sort();
    entries
}

#[test]
fn a_listing_says_which_entries_are_links() {
    let fixture = Fixture::new();
    symlink(fixture.outside.path(), fixture.skills().join("out")).unwrap();
    symlink(
        fixture.skills().join("real"),
        fixture.skills().join("alias"),
    )
    .unwrap();
    symlink(
        fixture.outside("SKILL.md"),
        fixture.skills().join("real/linked.md"),
    )
    .unwrap();

    assert_eq!(
        links_in(fixture.root(), ".atlas/skills"),
        [
            ("alias".to_string(), true),
            ("out".to_string(), true),
            ("real".to_string(), false)
        ]
    );
    assert_eq!(
        links_in(fixture.root(), ".atlas/skills/real"),
        [
            ("SKILL.md".to_string(), false),
            ("linked.md".to_string(), true)
        ]
    );
}

#[test]
fn a_save_over_a_hard_linked_skill_md_leaves_the_other_name_as_it_was() {
    let fixture = Fixture::new();
    let other = fixture.root().join("Notes/copy.md");
    fs::create_dir(fixture.root().join("Notes")).unwrap();
    fs::hard_link(fixture.skills().join("real/SKILL.md"), &other).unwrap();

    write_text(
        fixture.root(),
        ".atlas/skills/real/SKILL.md",
        "saved",
        BasedOn::ANY,
    )
    .unwrap();

    // The save renames a new file into place, so only SKILL.md's name has the new text.
    assert_eq!(
        fs::read_to_string(fixture.skills().join("real/SKILL.md")).unwrap(),
        "saved"
    );
    assert_eq!(fs::read_to_string(&other).unwrap(), "real");
}

/// `.atlas/skills/x -> ../automations` lands in `.atlas/automations`. That is
/// followed: the path already names `.atlas`, and anything under it can be
/// read by naming it, so the link reaches nothing a path could not.
#[test]
fn a_skill_linked_to_another_atlas_folder_is_followed() {
    let fixture = Fixture::new();
    let automations = fixture.root().join(".atlas/automations");
    fs::create_dir(&automations).unwrap();
    fs::write(automations.join("SKILL.md"), "automation").unwrap();
    symlink("../automations", fixture.skills().join("x")).unwrap();

    assert_eq!(
        read_text(fixture.root(), ".atlas/skills/x/SKILL.md")
            .unwrap()
            .text,
        "automation"
    );
}
