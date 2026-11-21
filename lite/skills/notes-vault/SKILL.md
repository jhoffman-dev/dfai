---
name: notes-vault
description: Read and write James's notes and meeting notes, which live as markdown in a private GitHub repository. Use whenever a question may be answered by his notes or a past meeting ("what did we decide about…", "what did Mara say…", "find my note on…"), and whenever something should be saved as a note or a meeting note. Explains where the vault is, how to find a note without reading the whole vault, and the rules for writing to it.
---

# James's notes vault

The notes are plain markdown files in the GitHub repository **`<owner>/<repo>`**
(branch `main`). Replace that name when installing this skill; nothing else
here is specific to one vault.

## Before anything else

Read `CLAUDE.md` at the root of the repository. It is the vault's own contract
(layout, how a note is written, the rules for writing) and it wins over this
skill wherever the two differ, because it travels with the notes.

## Reading: index first, then few files

Never clone-and-read or list the whole vault to answer a question. In order:

1. `_index/README.md`: the map, with a count per folder.
2. The one index file that fits: `_index/meetings/<YYYY>-<MM>.md` for a
   meeting, `_index/tags.md` for a topic, `_index/folders/<folder>.md` for an
   area. Each line is one note: path, tags, links, first sentence.
3. Open only the notes those lines point to. For a meeting, stop before
   `## Transcript` unless the answer needs who said what.
4. For an exact phrase, use repository code search rather than reading files.

Say which notes an answer came from, by path.

## Writing

- A new meeting note goes to `Meetings/<YYYY>/<MM>/<YYYY-MM-DD> <title>.md`,
  in the shape `CLAUDE.md` gives. A quick note with no clear home goes to
  `Inbox/`.
- No frontmatter. Title is the file name. Tags inline (`#meeting`). People,
  projects and earlier meetings as `[[links]]`.
- One small commit per piece of work, on `main`, with a message that says what
  changed. Pull first. If the push is refused, pull and retry.
- Never force-push, never delete notes (move to `Archive/`), never edit
  `_index/` or `.dfai-lite/`.

## How to reach the repository

Use whichever of these the product you are running in has, in this order:

1. A GitHub connector or integration with access to the repository.
2. `git` or `gh` in a sandbox, with the credentials that sandbox was given.
3. The GitHub REST API with a token James has provided for this purpose.

If none is available, say so plainly and ask James to connect GitHub; do not
answer from memory as if the notes had been read.
