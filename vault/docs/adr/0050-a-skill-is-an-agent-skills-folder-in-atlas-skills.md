---
type: adr
id: ADR-0050
title: A skill is an Agent Skills folder in .atlas/skills
status: proposed
date: 2026-10-28
---

# A skill is an Agent Skills folder in .atlas/skills

## Context

Automations already run Claude with a prompt note from `.atlas/prompts`
(ADR-0021). Issue #169 asks for a **Skills** section: a place to list, add,
edit and delete skills — each a name, a description and instructions — usable
from automations and from the chat, with the in-app Claude helping to draft or
improve one. The work is split into five pull requests; this record is the
first one's, and holds the decisions the other four build on: what a skill is
on disk, the rules it is held to, how it is saved, where it is visible, and
what the local API may do with it.

Anthropic's Agent Skills format already answers "what is a skill": a folder
whose name is the skill's, holding a `SKILL.md` with `name` and `description`
in its frontmatter and the instructions in its body. A skill written that way
can be copied into Claude Code or uploaded to Claude without being rewritten.

## Decision

1. **A skill is `.atlas/skills/<name>/SKILL.md`.** The folder's name is the
   skill's identity. The frontmatter holds `name` and `description`; the body,
   after the blank line that parts it from the frontmatter, is the
   instructions. A `name:` that differs from the folder, or is missing, is
   **reported as a problem, never silently fixed**: saving the folder's name
   from the editor puts it right, as the person's own act. Only `SKILL.md` is
   read. Anything else the folder holds (scripts, references, examples) is
   never opened, and stays untouched by every save.

2. **The rules live in `domain/skills`.**
   - _Name:_ 1–64 characters of `a-z`, `0-9` and `-`, with no leading,
     trailing or double hyphen, and equal to the folder. A name holding
     "claude" or "anthropic" is refused, as Agent Skills refuse it.
   - _Duplicates_ are refused in any case and after Unicode (NFKC)
     normalisation, so two folders can never be told apart only by how a name
     was typed. A lookup by name takes the exact folder first, else one equal
     in that comparison.
   - _Description:_ required, at most 1,024 characters, and no XML tags
     (`<example>`, `</b>`; a lone `<` or `a < b > c` is not a tag).
   - _Instructions:_ not blank, and at most 20,000 characters:
     `MAX_PROMPT_CHARACTERS`, which moves from the application's Claude step
     into the domain so a prompt note and a skill share one limit. Either is
     handed to the model as one argument (ADR-0021's argv limit).

3. **Use-cases in `application/skills`: list, read, create, save, delete.**
   - _Create_ writes the folder and a SKILL.md in one canonical form: `name`
     and `description` through `MarkdownPort.updateFrontmatter`, a blank
     line, then the instructions ending their last line.
   - _Save_ is byte-preserving (ADR-0003): only the frontmatter keys that
     changed are rewritten, through `updateFrontmatter` (which keeps comments,
     key order, quoting and unknown keys), and the body is replaced only when
     the instructions changed. Nothing is written when nothing changed. A
     skill whose frontmatter cannot be read is not saved over.
   - Every write is held to the file as it was read: the use-case re-reads
     SKILL.md and refuses (`NoteChangedError`) when its time or text differ,
     then writes with `expectedModified` and `expectedText` so the host
     refuses a change it made in between.
   - _Delete_ puts the whole folder in the system Trash, only while SKILL.md
     is unchanged since it was read (or still absent, for a folder that had
     none), and answers the other files that went with it so the person can
     be told. The host's `trashEntry` has no guard of its own, so the guard is
     the use-case's re-read; the window between that read and the Trash is the
     one every other undo and delete here already has.

4. **`.atlas/prompts` is not migrated.** Prompt notes keep working exactly as
   before; a rule's `prompt:` is unchanged. Letting a rule name a `skill:`
   instead is the third pull request.

5. **Skills are a sectioned path.** `.atlas/skills` joins
   `SECTIONED_ATLAS_PATHS`, so a skill is not in the sidebar, Pages, search,
   link resolution, `[[` suggestions or the index — the Skills page and the
   API are where it is seen. **The index schema is not bumped.** ADR-0026
   bumped it for templates so link rows already resolved to a template were
   read again; since #431 the refresh does that itself: a note gone from the
   listing is removed, and every note whose link pointed at it is re-read
   (`linkHolders`), so the first refresh after this lands takes any SKILL.md
   out and re-resolves what named it.

6. **Read on demand.** The window's reads gain a `skills` facet, made stale by
   any change under `.atlas/skills`. Nothing reads it at launch: only a page
   that asks for skills does, so no host call is added at start-up and the
   work budgets hold.

7. **The API and MCP read; they never write.** `GET /v1/skills`,
   `GET /v1/skills/{name}`, and the MCP tools `atlas_list_skills` and
   `atlas_read_skill`. A name is compared with the folders listed and never
   joined into a path. ADR-0016's addendum for #169 says why making, editing
   and deleting stay in the app.

## James to confirm

These were chosen as the recommended answers and are open until James says:

- **The reserved words.** "claude" and "anthropic" are refused anywhere in a
  name (`ask-claude` too), as Agent Skills uploads refuse them.
- **The chat attaches a skill, and that is all.** A skill is attached to a
  conversation explicitly (fourth pull request); it picks no model and
  changes no setting.
- **No rename in v1.** A skill keeps its folder's name; renaming means a new
  skill and deleting the old one.
- **"Ask Claude" drafts fill the editor.** Accepting a draft or an
  improvement puts it in the editor; only Save writes the file (fifth pull
  request).
- **The API stays read-only** for skills, as for templates and views.

## Consequences

- A vault's skills are ordinary Agent Skills folders another tool can read or
  write; DFAI reports what does not follow the rules instead of rewriting it.
- A hand-written SKILL.md keeps every byte an edit did not touch.
- A skill folder with extra files is supported, but DFAI only ever shows its
  SKILL.md; deleting the skill takes the extra files to the Trash, named.
- The prompt-note limit now lives in the domain; the Claude step reads it
  from there.
