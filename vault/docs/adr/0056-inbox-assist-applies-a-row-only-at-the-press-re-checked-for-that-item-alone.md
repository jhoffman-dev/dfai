---
type: adr
id: ADR-0056
title: Inbox assist applies a row only at the press, re-checked for that item alone
status: proposed
date: 2026-11-17
---

# Inbox assist applies a row only at the press, re-checked for that item alone

Extends ADR-0036's exception to ADR-0028. Slice 3 of #899 (#909).

## Context

Inbox assist (#899) asks Claude once about up to ten Inbox items and shows a
plan per item (slices 1 and 2, #900 and #906): make it a task or file it,
link or add the people it names, archive a duplicate, or ask. The model never
picks the action; it gives a closed answer, and the domain decides
(`packages/domain/src/inbox/assist-plan.ts`). Until now nothing was written.

ADR-0028 and PLAN.md's principle 2 say "AI proposes, James accepts. Claude
never edits a note on its own." ADR-0036 made one exception: the declared
step writes a meeting's summary and the owner's tasks. This record makes a
second, narrower one. It is the first slice of Inbox assist that writes.

The review of slices 1 and 2 added rules that bind this one (#899 comments):

1. The model never picks the action; the domain decides.
2. Fill in what is missing; never overwrite what is written.
3. A line is planned only when the item's own text and the vault confirm it.
4. **Nothing is applied from a batch answer as it stands.** One item's text
   can steer the model's answer for another item asked in the same ask, and
   no validator can tell.
5. Both notes are read again at apply time; a change since the preview asks.
   A duplicate whose newer copy holds anything the kept task lacks asks.
6. Text that is only quoted or forwarded is not the person's own words.
7. A read that was cut short asks.
8. The file's modified time never chooses which copy is archived.
9. Notes with unsaved typing, or changed in the last 10 minutes, are skipped.
10. Nothing is deleted. Archive only.

## Decision

### James still accepts, a row or all sure rows at a time

Each planned row gets **Apply**, and the panel gets **Apply all sure ones**,
which applies every row that can be applied, one after another. Nothing is
written until one of them is pressed. A question or a row left is never
applied. Nothing runs unattended; that is slice 5, and needs its own record.

### Rule 4: a model-free re-check of that one item, at the press

The default chosen is a domain re-check, not a fresh ask per item.
`assistRecheck` (`packages/domain/src/inbox/assist-recheck.ts`) takes the
row, what the preview saw of the item (Claude's answer, and the digests of
the item's and the kept task's text), the notes as read again at the press,
and the vault as it is then. It makes the plan again **for that item alone**,
from its own words and the vault, and applies only if it is the plan shown.

It is sufficient on its own for everything but two choices, said below:
every other change it applies is one it can justify from the item's own text
and the vault. Claude's answer is trusted
for no more than its choice among options the domain computed: what kind of
thing the item is (a closed set), which of the vault's projects (a list the
domain offered), and which of the tasks the title rule listed. A steered
answer can therefore only choose among real, offered options, fill only
fields that are empty, and be seen before the press and undone after it.

A fresh ask per item was rejected: it spends the hourly allowance ten times
over, and it still trusts a model's answer. Applying the batch answer as it
stands was rejected by rule 4.

### What is trusted: the kind and the project (#911)

Said plainly: a steered batch answer can choose the **wrong real project**,
or the **wrong kind** (a task where the person meant a note, or the other
way), with nothing in the item's text to back the choice. The re-check can
only confirm that the project is a real one offered, and that the field was
empty. At apply-by-hand the person reading the row is the only defence, so a
filing or task row says so beside Apply: "Claude chose Larkspur Payroll;
nothing in the item confirms it. Check it before you apply." This **blocks
slice 5 (unattended)** until the project and the kind have evidence of their
own in the item, or their own question.

### The argument, per row kind

| Row kind                     | Applied?             | What the domain confirms without the model                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Make it a task               | yes                  | The kind is Claude's choice from a closed set. The item is not a task yet and has no type of its own (else the plan asks). Writes `type` and `status` only while both are empty.                                                                                                                                                             |
| File a note                  | yes                  | The project is Claude's choice among the filing targets the domain offered; the re-check finds it still one. Writes `project` only while it is empty.                                                                                                                                                                                        |
| A due date, on either        | with evidence        | A date is a free value, not a choice among options, and DFAI has no reader of its own for dates in prose. So it is applied only when the item's own words say it as `YYYY-MM-DD`; "before December" asks.                                                                                                                                    |
| A task that waits on someone | **no: preview-only** | Clarify writes `waiting_on` only with the Waiting status, and an Inbox task's status is written already (`inbox`): applying it would write over a field. It also names a person only Claude chose. It stays preview-only in this slice.                                                                                                      |
| Link a person                | yes                  | Their address, or their full name of two words or more, is in the item's own words — not only in quoted or forwarded text — and nothing in it says otherwise (slice 2's rules, made again from the text now). Writes `people` only while it is empty.                                                                                        |
| Add a person                 | yes                  | Their full name and the very address they are added under are both in the item's own words; nobody in People, the Archive included, is them exactly or nearly; no note has their name as its title, in the index or in the tree. Made with that address, then linked.                                                                        |
| A duplicate                  | yes                  | The same title by the title rule, Claude's pick among the tasks it listed; made again from both notes as read now: the kept task still open, filed alike, not differing on due, waiting-on, defer, people or contexts; and `newerHolds`, computed afresh, empty. The Inbox copy is the one archived, always; the kept task is never written. |
| A question, or left          | never                | —                                                                                                                                                                                                                                                                                                                                            |

### When it asks at the press

It writes nothing and says why when: the item is gone; it or the kept task
has typing not saved, or changed in the last 10 minutes (the injected
clock); a read was cut short (the open tasks' query; a cut read of the
titles a new person would take counts every name as taken); a frontmatter block cannot be read; a field the row
fills is written now; the kept task is no longer an open task; the kept task
says it was made after the copy (rule 8, below); the two differ now; the copy
holds anything the kept task lacks; the person to add is in People now, or a
note has their name; the item no longer names a person it links or adds;
anything it rests on is found only in quoted or forwarded text; the due date
is not in the item's own words; the plan made again is not the plan shown;
or the item or the kept task says anything other than at the preview.

### Quoted and forwarded text (rule 6)

`assistOwnWords` (`packages/domain/src/inbox/assist-own-words.ts`) is the
definition, and its tests pin it. Not the person's own words, line by line:
a line whose first character other than a space is `>`; a quote's
attribution (`On … wrote:`), wrapped by a mail client onto as many as four
lines: from a line opening `On ` to the first ending `wrote:`, or ending `:`
with only quoted lines, or nothing, after it; a header line starting `From:`, `To:`, `Cc:`,
`Bcc:`, `Subject:`, `Sent:`, `Date:` or `Reply-To:`; and everything from a
forwarded message's separator (`---------- Forwarded message ----------`,
`-----Original Message-----`, `Begin forwarded message:`) or the first
`From:` header to the end. It errs toward asking.

A due date counts only as a word of the item's own prose: `2026-12-01` on
its own, perhaps in brackets or before a full stop — never inside a URL, a
path, a link or a longer run of digits, letters, slashes or dashes — and only
a real day still ahead (`2026-02-30` and a day passed ask).

### Which copy is archived (rule 8)

Always the Inbox item the row is on. A file's modified time is never read
for it. Where both notes say when they were made (`created`), a kept task
made after the copy asks; a `created` that reads as no time asks. Where
either says nothing, the copy is the one in the Inbox: Inbox captures carry
no `created`, and the kept task is, by the title rule, not in the Inbox.

### What it writes, and how it is undone

Every write goes through a use-case the Inbox already uses by hand. Nothing
under `packages/adapters` changes, and there is no new port.

| What                                              | Through                                                                                                                                                                        | Undo                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Make it a task, its due date                      | `clarifyInboxItem`: one byte-preserving save                                                                                                                                   | The item's whole text put back                                                                            |
| File it under its project                         | `clarifyInboxItem` → `processInboxItems`: a move, then its link where it lands                                                                                                 | Moved back to exactly where it was, rewriting no link; its text put back                                  |
| Other notes' links to it, rewritten by the filing | the filing's link update, each note recorded with its text before and after                                                                                                    | Each put back byte for byte; refused, naming the note, once it says anything else                         |
| Link its people                                   | `setNoteProperties` on the item                                                                                                                                                | Part of the item's text put back                                                                          |
| Add a person                                      | `createPerson`, with their address as the item spells it, then the link above                                                                                                  | Put in the system Trash, only while byte for byte as made and no other note links them; otherwise refused |
| Archive a duplicate                               | `setNoteProperties` (`atlas_duplicate_of`), then `archiveNotes` (a numbered name when the Archive has its name)                                                                | Moved back from the Archive to exactly where it was, rewriting no link; its text put back                 |
| Log marks and entries                             | `appendToRuleLog`, rule id `inbox-assist`: `begun` before a row's first write, `step` after each person made, then a closing entry (`run`, `failed` or `undo`, naming the row) | —                                                                                                         |
| One Activity line per apply and undo              | the Activity log, outside the vault                                                                                                                                            | —                                                                                                         |

Every write on the item is held to the exact text the row checked or last
left, and refuses before it writes: Clarify is handed that text
(`expectedText`) and refuses a note that says anything else before planning
anything; each later write passes it as `ifText` to `setNoteProperties`,
which compares it with what it reads, and the host's own save is held to the
digest of what was read, so an edit within the disk's timestamp tick is
refused too. Never-overwrite does not rest on a rollback. Two moments are
still held to the file's time alone: the stamp the filing, or the Archive,
writes where the note lands, read just after the move (the move's and
rewrite's own use-cases, unchanged here).

A row is applied whole or not at all. Its writes are recorded as they land;
a write that fails takes back every write before it, item first and then any
person it added, and says so ("Tobias Fenn was added, then taken out again").
What could not be taken back is left, logged as a failed entry, and said.

Undo is one exact undo per row, through the Inbox's own
(`undoClarifyInboxItem`, asked to be exact): the item from where it was to
where it is, its whole text before and after, and each other note its filing
rewrote. Moved back, it rewrites no link of its own accord: it puts back only
what it recorded, so every byte of every note is as it was. It is refused, with nothing touched, when the
item says anything other than what the row left, has typing not saved, or
another note has taken its old place; or when a person it added was edited
since, or is linked from any note but the item (read from the notes on disk:
the index may not have a link just saved). **Undo all** takes the rows back the last applied first, each on its
own. "Apply all" checks for an abort between rows: put away, it finishes the
row it is on and starts no other.

### What is not undoable

- Undo is held by the panel for as long as it is shown. Dismissed, or after
  a restart, the log still says what was done (`assisted` lines with each
  item's digest), but no Undo is offered; slice 5's "Undo this run" needs it
  durable, and its own record.
- A folder a filing or an archive made stays when the note moves back.
- Before a row, nothing is checked against a crash. A crash mid-row leaves
  the row's `begun` mark (the item, the digest of what it said, what it was
  to do) and a `step` for each person made, with no closing entry. The next
  Suggest shows it under **Left unfinished**, saying exactly what is on disk
  — the item as it was, changed, or gone from where it was; each person made
  as made, changed, or gone — and how to put it right by hand. Nothing is
  repaired for the person, and the undo held in memory is lost with the
  crash. The before-bytes are not in the log: the item is in the vault, and
  synced, and the digest says whether it is still that text.
- Filing by hand, the Inbox's own Undo still moves the note back rewriting
  links, as before: a bare link to a title another note shares can come back
  path-qualified (#911). Inbox assist's undo asks for the exact undo; the
  Inbox's by-hand Undo is unchanged here and is left for its own fix.

## Consequences

- The Inbox's first writes from Inbox assist are James's presses, each one
  re-checked alone. Cross-item steering can change only which offered option
  a row shows, never what is written without being shown.
- Many rows will ask at the press that the preview planned: a due date read
  from prose, a forwarded capture, a duplicate whose copy has notes of its
  own. That is the intent; slice 6 makes questions one tap.
- Task rows that wait on someone stay preview-only until a slice decides how
  a status written as `inbox` may be changed.
- The run log gains two line kinds. `undoLastRun` reads only a rule's own
  log, and refuses any line its rule's action never makes, so a rule's "Undo
  last run" never carries one out.
