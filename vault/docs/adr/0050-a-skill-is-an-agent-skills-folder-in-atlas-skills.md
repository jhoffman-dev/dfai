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
   - _Description:_ required, at most 1,024 characters, and no XML: no tag
     whose name starts with any letter, `_` or `:` as XML 1.0 names do
     (`<example>`, `</b>`, `<résumé>`, `<名前>`), and — so a description is
     plain text wherever it is taken — no comment, CDATA section or
     processing instruction either. A lone `<` or `a < b > c` is not XML.
   - _Lengths are counted in characters_ (Unicode code points), as the Agent
     Skills validator counts them, so an emoji is one. Prompt notes still
     count UTF-16 units, as they did.
   - _Instructions:_ not blank, and at most 20,000 characters:
     `MAX_PROMPT_CHARACTERS`, which moves from the application's Claude step
     into the domain so a prompt note and a skill share one limit. Either is
     handed to the model as one argument (ADR-0021's argv limit).

3. **Use-cases in `application/skills`: list, read, create, save, delete.**
   - _Create_ writes the folder and a SKILL.md in one canonical form: `name`
     and `description` through `MarkdownPort.updateFrontmatter`, a blank
     line, then the instructions and one line ending, which a reading does not
     count, so instructions saved at N characters read back as N (a skill at
     the 20,000 limit stays within it). A folder of exactly
     the name with no SKILL.md yet is the skill's, and its SKILL.md is written
     into it; saving such a folder's skill does the same. Both write through
     `createNote`, which never overwrites. When a create makes the folder but
     not its SKILL.md, it lists the folder again: a SKILL.md there now is
     another program's, and the create is refused as a name already taken;
     a folder it made that is still empty is trashed, so no half-made skill
     holds the name; one holding anything at all is left alone. A folder clash the listing could not see (a file of that
     name, a folder made since) is refused as a name already taken.
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
     none). The folder is walked first and SKILL.md checked right before the
     Trash. It answers the other files that went with it, dotfiles such as
     `.DS_Store` left unnamed, and the warning says that files in subfolders,
     however deep, go too.
   - _Missing is not unreadable._ The host refuses a file that is gone, too
     large or not text with one error, so a refused read is told apart by
     whether the folder still lists SKILL.md. One that is there but cannot be
     read is a `file` problem, said in DFAI's own words (never the host's,
     which can name the Mac's folders), and such a skill is neither saved over
     nor deleted here. A `.atlas/skills` that `.atlas` lists but the host will
     not is a failure, not a vault with no skills.
   - The host's `trashEntry` has no guard of its own, so the guard is the
     use-case's re-read; the window between that read and the Trash is the
     one every other undo and delete here already has.
   - _Line endings._ Changed instructions take CRLF when most of the file's
     lines end that way. The shared frontmatter writer now keeps each
     untouched line's own ending, gives a changed line the ending of the line
     it replaced, and a new line the ending most of the block's lines have,
     so a block edited on two machines keeps its mixed endings.
   - _Not yet: links._ The host's listings do not say whether a SKILL.md is a
     symbolic link, so one is read as the file it points to; refusing links
     needs the host to report them (a follow-up).

4. **`.atlas/prompts` is not migrated.** Prompt notes keep working exactly as
   before; a rule's `prompt:` is unchanged. Letting a rule name a `skill:`
   instead is the third pull request, recorded in ADR-0028's amendment of
   2026-10-28.

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
   work budgets hold. The sidebar's walk of `.atlas`, which does run at
   launch, stops at `.atlas/skills` — it neither lists nor reads a skill's
   folder — and nothing in one is ever a view or a dashboard, however its
   references are marked (`isSkillPath`, as `isTemplateNote` is for
   templates).

7. **The API and MCP read; they never write.** `GET /v1/skills`,
   `GET /v1/skills/{name}`, and the MCP tools `atlas_list_skills` and
   `atlas_read_skill`. A name is compared with the folders listed and never
   joined into a path. ADR-0016's addendum for #169 says why making, editing
   and deleting stay in the app.

8. **The chat asks with a skill only the person attached** (fourth pull
   request). A picker by the box, or `/name` at the start of a message,
   attaches one; it shows as a chip whose × takes it out of the next turn.
   The model is never shown the vault's skills to choose from, so a note or a
   tool result cannot bring one in. The skill is read again for every turn
   (`readSkillToUse`, shared with automations) and goes into the system
   prompt after DFAI's own rules, which still hold, inside a
   `<chosen_skill>` tag that its text, a note's or a tool result's can neither
   open nor close (`neutralizeFraming`). A skill with a problem, or over the
   run cap measured as `skillRunProblem` measures it, is refused before
   Claude is asked; the chip and the turn say why. A `/name` question is
   shown as typed and holds the chat busy while its skill is read, so a
   second send is refused and a past chat is not opened meanwhile; New chat
   meanwhile leaves it with the chat it was asked in, as it leaves any
   question still being answered. It counts as a turn begun from the
   start, so a past chat picked before it is not shown over it, and it owns
   the turn's Stop: Stop during the read frees the chat at once, keeps the
   question as typed, and the read, landing late, attaches nothing and asks
   nothing. A turn stopped before the model is asked asks nothing and keeps
   nothing, so no "Used the skill" line is written for it. While the
   picker's skills are being read it says "Reading skills…", and Enter holds
   a `/word` rather than send it. A `/word` is the question as typed when
   no skill is called that or the skills cannot be read. A host refusal is
   "could not be read"; any other error is a bug and is not dressed as one. The chat note records
   "Used the skill <name>" with each answer. A skill is **not kept with a
   chat**: a reopened chat starts without one (restoring it would mean a new
   chat-note key read back on open, more than v1 needs). The picker reads the
   skills only once it is first opened, through the Skills page's own read.
   The API and MCP need nothing new: a chat is the app's, and a client
   already reads a skill's instructions (`atlas_read_skill`) to use as it
   likes.

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
