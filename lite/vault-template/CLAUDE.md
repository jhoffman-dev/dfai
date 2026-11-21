# This vault

Markdown notes in folders, synced through this GitHub repository. People edit
them in DFAI Lite; Claude reads and writes them here. This file is the entry
point: read it first, then use `_index/` to find notes without opening them.

## Find things cheaply

Do not list or read the whole vault. Go through the index:

| To find…                     | Read                                            |
| ---------------------------- | ----------------------------------------------- |
| What folders and areas exist | `_index/README.md` (counts per folder, the map) |
| Notes in a folder            | `_index/folders/<folder>.md`                    |
| Notes with a tag             | `_index/tags.md`                                |
| A meeting, by date or person | `_index/meetings/<YYYY>-<MM>.md`                |
| What links to a note         | the note's line in its folder index (`←` lists) |

Each index line is one note: its path, tags, links out, and its first sentence.
Pick the few notes that matter from those lines, then open only those. For an
exact phrase, search the repository's code instead of reading files.

`_index/` is generated on every push. It can be a minute behind: if a note
and the index disagree, the note is right.

## Layout

| Folder                   | Holds                                                           |
| ------------------------ | --------------------------------------------------------------- |
| `Inbox/`                 | Quick notes, unfiled. New notes with no obvious home go here.   |
| `Meetings/<YYYY>/<MM>/`  | One note per meeting (shape below).                             |
| `People/`                | One note per person, named as they are linked: `Mara Quill.md`. |
| `Projects/`, `Areas/`    | Work with an end, and ongoing responsibilities.                 |
| `Resources/`             | Reference material and permanent notes.                         |
| `Archive/`               | Finished or dormant. Move here; do not delete.                  |
| `skills/<name>/SKILL.md` | Instructions for Claude on jobs done often in this vault.       |
| `_index/`                | Generated. Never edit.                                          |
| `.dfai-lite/`            | The app's own state (favourites). Leave it alone.               |

## How a note is written

- A note is one `.md` file. **Its title is its file name.** No frontmatter:
  never add a `---` block at the top.
- Start with one plain sentence saying what the note is. The index shows it.
- Tags are inline: `#project`, `#area/health`. Lower case, `/` to nest.
  Reuse a tag from `_index/tags.md` before making a new one.
- Link with `[[Note name]]`, or `[[Note name|shown text]]`. Link people,
  projects and earlier meetings whenever they are mentioned: links are how
  notes are found later. A link to a note that does not exist yet is fine.
- File names: plain words, no `/ \ : * ? " < > | #  ^ [ ]`.

## A meeting note

Path: `Meetings/<YYYY>/<MM>/<YYYY-MM-DD> <title>.md`. If that file exists, it
is the same meeting: add to it rather than making a second one.

```markdown
One sentence on what was decided or discussed. #meeting

- When: 2026-11-21 10:00–10:30
- With: [[Mara Quill]], [[Tobias Fenn]]
- About: [[Larkspur rollout]]

## Summary

## Decisions

## Next steps

- [[Mara Quill]] sends the revised plan by Friday.

## Transcript
```

Leave out a section that has nothing in it. The transcript, when there is
one, goes last so a reader can stop before it.

## Rules for writing here

1. **Pull before you write, and commit small.** One commit per piece of work,
   with a message that says what changed: `Meeting: 2026-11-21 Weekly sync`.
2. **Never force-push, never rewrite history, never delete in bulk.** To
   remove a note, move it to `Archive/`.
3. **Add, do not overwrite.** When changing a note a person wrote, append or
   edit the part asked about; leave the rest byte for byte.
4. **Renaming or moving a note** means updating every `[[link]]` to it in the
   same commit. The folder index shows who links to it.
5. **Do not touch `_index/` or `.dfai-lite/`.**
6. If a push is refused because the branch moved, pull and try again. Never
   resolve it by overwriting.
7. A file ending `(conflict <date>).md` is a second version of a note the app
   kept because both sides changed. Leave it for the owner unless asked to
   merge it.
