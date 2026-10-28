---
type: adr
id: ADR-0029
title: Tasks follow GTD, with exactly eight statuses, and old statuses are migrated once
status: proposed
date: 2026-10-07
---

# ADR-0029 — Tasks follow GTD, with exactly eight statuses, and old statuses are migrated once

## Context

James has run GTD for years: Inbox, Backlog, Next Action, In Progress,
Waiting, Someday, Longterm, Archive. Backlog exists because Next Action
became chaos; In Progress because tasks span days. Atlas's task type today
has `backlog, next, doing, review, done` (this repository's own board), and
James's vault may hold others. Changing a select's options without moving
the notes would strand their values.

## Decision

**The built-in Task type's `status` has exactly these options, in this
order: `inbox, backlog, next-action, in-progress, waiting, someday,
longterm, archive`, labelled as James writes them.** New tasks are `inbox`.
~~`waiting` requires a `waiting_on` relation to a Person.~~ _(Amended 2026-10-14, #202: James decided
`waiting` is a status like any other and never requires `waiting_on`: "there
are a million reasons for a ticket to end up there". `waiting_on` stays,
optional — offered where Waiting is picked, never demanded.)_ Tasks also gain
`contexts` (multi-select), `defer`, `due`, `estimate` (minutes), `source`
(a block link) and `project` (relation to Project / Area).

**"Done" is not a status.** A ticked task is `archive` with `completed:`
set to the day (the type's `done:` option is `archive`), so finished work
leaves every list in one move and the Archive (Phase 23) can take it later.

**Old statuses are migrated once, by a previewed rewrite** — a dry-run table
of every task, old → new (`backlog→backlog`, `next→next-action`,
`doing→in-progress`, `review→in-progress`, `done→archive` with `completed`
from the file's last change; anything unknown → `inbox`), then one write per
note through the byte-preserving save, recorded as one undoable run. The
mapping is a pure domain table, editable before running. It is built on the
type editor's existing `renameOption` note migration
(`domain/types/note-migration.ts`, `application/types/migrate-notes.ts`),
extended from one rename to a many-to-one mapping plus a set `completed`.

## Consequences

- Task is already a built-in type (`BUILT_IN_TYPES`), but nothing writes a
  built-in's file into a vault. An "ensure built-in types" step, which adds
  missing properties and never removes James's, lands with this change.

- Views and automations that filter on old values are rewritten in the same
  run, or listed for James if they cannot be.
- This repository's dev vault keeps its own `phase` workflow only if it is
  migrated too; it is the first test vault.
- Checklist lines (`- [ ]`) in a task body are the subtask model; In
  Progress plus a progress bar replaces a status per step.

## As built (P30-02, 2026-10-08)

Where the build differs from, or settles, what is written above:

- **The migration is its own use-case, not `renameOption` extended.** A
  rename goes through `migrateNotes`, which keeps no record of what a note
  held, so it cannot be undone byte for byte. The GTD migration
  (`application/gtd`) reads every file it will change, writes a record of each
  one's frontmatter as it was and as it will be to
  `.atlas/migrations/task-statuses.md` **before** changing anything, then
  writes each file once — frontmatter only, refused by the host if the file
  moved on since it was read. Undo puts back the recorded frontmatter wherever
  the file still says what the migration wrote, so a run, then an undo, with
  nothing edited between, gives every file back byte for byte. A file whose
  frontmatter was edited since is left and named; one whose body alone was
  edited gets its frontmatter back and keeps the new body.
- **It is resumable and idempotent.** A GTD status maps to itself whatever the
  mapping says, so a second run finds nothing to do. A run cut off partway is
  run again from a fresh preview of what is left, and its record is merged
  into the first, so one undo covers both. A file in both keeps what it was
  before the first run only while it still held what the first run wrote;
  otherwise — the first never wrote it, or it was edited or synced since —
  undo gives back what the second run found, and the edit is kept. A file
  the second run made afresh — the first run's was deleted since — is
  recorded as made by the second, so undo takes it away while still as made.
  The record also says whether its last run got to the end, and which files
  it left; a run writes it unfinished before changing anything and marks it
  finished once it has tried every file.
- **Unknown includes none.** A task with no status goes to `inbox`, as an
  unknown one does. A status spelled another way (`Next Action`,
  `in_progress`) is read as the status it names, and one written as a
  one-item list (`[next-action]`) is written back as that status.
- **A status is what the index reads.** The rules, the migration and the
  views read a status trimmed, a one-item list as its item, as the index
  stores it: `waiting `, `[waiting]` and `waiting` are all Waiting to the
  rule, and a list of blank names in `waiting_on` is nobody. A GTD status set
  in another spelling is written as the status itself, so the files stay in
  the one spelling a tick and a board compare with.
- **The migration never makes what the rules refuse.** Waiting stays a
  mapping target, but a task it would send to Waiting with nobody in
  `waiting_on` goes to the Inbox instead, and the preview says why beside it.
  (Refusing Waiting as a target was rejected: a vault's own `blocked` whose
  tasks do say who they wait on should go there.) _(Amended 2026-10-14, #202: with Waiting no
  longer needing anyone, a task the mapping sends to Waiting goes there, and
  an automation that sets Waiting is rewritten like any other.)_
- **The Task type keeps what the vault has.** Its `status` becomes the eight;
  every other GTD property it has no key for is added; a key it has is left as
  it is, even where GTD would have made it another kind (this repository's
  `estimate` stays text).
- **Templates of type task are migrated with the tasks**, so a new task from
  one never starts on a status that no longer exists. Capture then sets
  `inbox` when the Task type has it.
- **Views and automations** are those in `.atlas/views` and
  `.atlas/automations`. Only a query of tasks alone is rewritten — a project's
  `done` is not a task's — in place, by the value's span; a table view's
  `filters:` likewise. Picking a status (`=`, `is`) is carried over. Leaving
  one out (`!=`, `isNot`, `=` under `NOT`) is carried only when no other old
  status becomes the same one and no task already holds it, and a status
  nobody knew is never carried to the Inbox. Everything else that names an old status is listed instead: a
  query over tasks and another type, those comparisons, any other operator,
  any SQL view that reads `status`, and an automation that would set a status
  on mixed types, an unknown status, or Waiting. A dashboard's widgets are not
  read.
- **The GTD views** — Inbox, Next actions, Waiting, Someday and Longterm — are
  query views written into `.atlas/views` by the same run, never over a view
  of the same name.
- **The rules hold where every write ends up**, not at call sites: in
  `setNoteProperties` (every write of a note no pane holds — views, the type
  table, the API, automations' set and undo, the type editor's note
  migration), in `saveNote` (a pane's write), in `createNote` (every new
  note: capture, quick-add, "+" on a board or table, POST /v1/notes, a related
  note, a template) and in chat's proposals. `taskRuleChanges` judges the note
  a change leaves, so a type change that makes a Waiting note a task is
  refused too. _(Amended 2026-10-14, #202: no rule refuses a Waiting task now; the rules that
  remain date a finished task.)_ A refusal is each path's own error: `invalid` from the API, the
  view's or pane's message in the app, a line in an automation's log. Not
  held, by design: Atlas's own files (types, settings), a chat's transcript,
  today's note, notes a source writes from outside data (ADR-0012), and the
  migration and its undo, which write recorded frontmatter.
- **Unticking after a restart reopens a task as Next Action.** What a task
  held before it was ticked is remembered for the session only. With nothing
  remembered, unticking — and a repeating task rolling on — puts it at Next
  Action, not the Inbox: it was something to do. Persisting the earlier
  status in a frontmatter key was rejected: every finished task would carry a
  key nobody asked for, which syncs and outlives its use.
- **The Inbox does not read every task on every open.** A quick look says
  yes — and the tasks are read — while the Task type is not yet GTD's, the
  record says its last run stopped partway or left files, a GTD view the move
  adds is missing, the index holds a task whose status is not one of the eight
  (or none). _(Amended 2026-10-14, #202: it no longer asks after a task Waiting with nobody
  to wait on.)_ It never says no
  while a preview has work, except for a status written as a one-item list,
  which the index flattens: the rules already read it as its item, and the
  next write of its status rewrites it.
- **The weekly review reads staleness from the file (P30-07).** "Waiting for
  more than 7 days" and "Someday or Longterm untouched for 30 days" are
  measured from the file's last change, as the index holds it — not from a
  "waiting since" key, which would be one more key nobody asked for, syncing
  and outliving its use, as the earlier status was turned down above. The
  price: any write to the file counts as a look. Editing a stale Waiting
  task's body, the review's own Defer, a bulk rewrite (a tag rename, an
  automation's set, this migration and its undo), a sync that rewrites the
  file, or a fresh clone onto another Mac — where every file is new — all
  reset it, and a stale item drops out of the review until it goes stale
  again. Kept because the review asks "has anyone looked at this lately",
  and a file nobody has changed is the honest answer to that; a recorded
  "since" can be added later without changing the sections' rules.

## As built (P30-03, 2026-10-08): checklists

- **A box is what the editor draws.** `checklistLines` reads every
  `taskItem` of the parsed note, nested ones after their line, so the index,
  the bar and promoting a line count the same boxes. A list that mixes boxed
  and plain items is a checklist to the editor, and so to the count.
- **Progress is worked out once, in TypeScript**, as the index is filled:
  the share ticked, a whole percentage rounded down (100 only when every box
  is), null with no box. It is stored on the file's row beside its summary
  (`files.progress`, schema 12) with a `checks` row per box, and Rust only
  selects it into each type's view (ADR-0005). A type that declares its own
  `progress` keeps it: TypeScript tells the host not to add the column, the
  query language does not offer the built-in, and no bar is drawn.
- **Promoting a line is one use-case** for the app and the API
  (`promoteChecklistLine`): the task is made by `createNote` and the line
  rewritten by `saveNote`, the chokepoints above. A ticked line's task starts
  in Archive, dated by those rules. If the line's note cannot be written, the
  task just made is taken back. Undo (the app only) restores the note's bytes
  and trashes the task, refused if either changed since.
- **Nothing the line said is lost** (after the adversarial pass). A line of
  plain words becomes the link alone, aliased with those words when the
  task's name had to differ; a line holding anything more — a link, a tag,
  code, marks, a character markdown reads — keeps it all after the link, and
  its markdown becomes the task's body. A line starting with a link to a task
  note is that task already: promoting it again is refused. The task's name
  is cut by whole characters to fit a file name with a number after it.
- **The box prefilter is a superset**: any `[ ]`, `[x]` or `[X]` in a body
  sends it to the parser, since a box may follow a marker on its parent's
  line or start the line after a bare marker.
- **A note read again from its file is not undoable** (`showAsRead`), app
  wide: ⌘Z after a promotion, a sync or another pane's save would otherwise
  put back what the file no longer says, and save it.
- **Schema 11 collides with P28-03's change feed (#9)**, which is also 11 with
  other columns: whichever of #9 and #22 merges second must bump to 12 and
  create both sets of columns.
- **Not done**: grouping a board by `progress` is allowed, as by `modified`,
  and dropping a card there writes a `progress` key nobody reads. A list
  written with `*`, `+` or numbers is rewritten with `-` when a line of it is
  promoted, as any edit to it is (ADR-0003): the editor's checklist node
  holds no marker or numbering, so keeping them would mean a new node
  attribute through the editor, the reader and the writer — not cheap.

## Addendum (#108, 2026-10-28): a task chosen for today carries the day

GTD leaves "what will I do today" to the person; the Today page (#111) showed
what needs attention but had nowhere to say what was chosen.

- **A choice is a date, `focus`, on the task.** `focus: 2026-10-28` says the
  task was chosen for that day. A date rather than a flag, so yesterday's
  choice stops being today's without anything being written at midnight: the
  page, read again when the day turns, lists it under **Carried over** until
  it is kept (`focus` set to today) or dropped (the key taken out). Taking the
  key out, rather than writing it empty, gives a task chosen and then
  unchosen back byte for byte (ADR-0003). A `focus` on a day still to come is
  that day's choice: its row says _Chosen for 2026-11-02_, and Today moves the
  choice to today, the toast naming the day it was.
- **Finishing ends the choice** (amended in PR #602's fix round). A task
  finished, or a repeating one rolled on, loses a dated `focus`. A roll is
  `lastCompleted` written together with `due` or `status`, as the roll writes
  them; a hand edit of `lastCompleted` alone keeps the choice. A blank
  `focus:`, as a property template writes it, is no choice and stays, and
  reopening a task leaves its `focus` as it is. It is a task
  rule, so every tick does it, from Today, a view, a board or the API. Undo
  gives the key back as written. Otherwise a ticked repeating task stays
  under Chosen for today, looking as if the tick did nothing, and a task
  reopened weeks later comes back under Carried over. The first draft kept
  `focus` on a finished task so `focus = @today` could count what got done;
  that count is the price.
- **Chosen for today leads the page, and claims its tasks whatever their
  status** — an In Progress task chosen for today is under Chosen alone, as an
  overdue one is under Overdue alone. Carried over comes next and is drawn
  only while it holds something. Both are ordered as Overdue is (the earliest
  due first, then by title); Carried over the most recently chosen first. A
  hand order (drag to rank) is not kept: it would need a rank key beside the
  day, and nobody has asked for one yet.
- **The Task type gains `focus` on opening, not with the move to GTD.** It is
  added as DFAI's shipped properties are (#162): only lines, never over a key
  the type has, and never again once it is taken off. GTD's own keys stay the
  move's offer. Putting `focus` in the move instead would offer every vault
  already on GTD the move again. Two Macs that both open after the upgrade
  before syncing write the same lines and the same record. Their syncs merge
  with no conflict and one `focus` key (`two-macs.task-focus.test.ts`).
- **A vault chooses only where it keeps the day** (`choosesForToday`). Its
  Task type has `focus` as a date, or it has no Task type yet and gets the
  built-in one. A vault whose type took `focus` off, or made it another kind,
  is offered no Today, Keep or Drop. It has neither choice section, and the
  API refuses with `invalid`.
- **A `focus` that is not one day is the person's own** (`focusIsOwn`):
  words, a link, a number, a list of several. Such a task is never listed as
  chosen. A choice made through the page or the API is refused against the
  frontmatter the write reads, so nothing is written over it, and finishing
  leaves it alone. The index reads the same rule (`focusIsOwn` in the review
  statement), and a test holds the two to agree.
- **A row's choice is part of what it showed**: `stillAsRead` compares
  `focus` too, so a Drop pressed after another Mac kept the task is refused
  rather than taking today's choice away.
- **The planning tray lists what was chosen first**: the open tasks whose
  `focus` is `@today` (the query language's day, as in every view), whatever
  their status, then the next actions. Within each, the unscheduled come
  first. A task deferred to a later day is left out, as Today leaves it out.
- **The API chooses through `POST /v1/today/choose` `{ path, chosen }`**, on
  the app's clock, through the same write as a property change; MCP's
  `atlas_choose_for_today` calls it.
