---
type: adr
id: ADR-0036
title: A declared step writes a meeting's summary and the owner's tasks, and cross-provider copies are linked
status: proposed
date: 2026-10-14
---

# ADR-0036 — A declared step writes a meeting's summary and the owner's tasks, and cross-provider copies are linked

## Context

The maintainer's request, 2026-10-14: when a meeting lands, link its people
and whatever else can be worked out, link the same meeting recorded twice,
put a Claude-written summary at the top, list the action items with who owns
them, and make **his own** action items into tasks, linked both ways. Missing
action items out of meetings is, in his words, "one of my biggest flaws".
He likes linking duplicates through the existing `Duplicate of` property
(`atlas_duplicate_of`).

What is true today:

- **The extraction exists and is switched off.** Meeting extraction with
  Claude (ADR-0028, P29-05, #18) is a built-in automation preset ("Pull
  actions and decisions out of a new meeting"). A Claude step reads the
  transcript and proposes `task`, `waiting`, `decision` and `follow-up`
  items, each citing a transcript turn, with an owner and a confidence. The
  owner is resolved in the domain (`itemOwner`) from the owner the model
  wrote, which is not the same as deciding it independently: `itemOwner`
  trusts "You" and the profile's name as written, and only then checks the
  cited speaker (`spokenByAnother`, which caps confidence at medium). Accept
  makes the task and links it into `meeting.tasks`. In the maintainer's vault
  the preset was never enabled, no prompt note existed, no proposal had ever
  been made, and his Meeting type lacked the `tasks` and `decisions`
  relations that Accept needs. Whether he would have clicked through the
  proposals is unknown.
- **No step writes model text into a note.** ADR-0028: "A Claude step never
  edits a note." PLAN.md section 11, principle 2: "AI proposes, James
  accepts. Claude never edits a note on its own." This record is a deviation
  from both, and is the whole feature.
- **Duplicates are same-provider only.** Dedupe is `provider` + `external_id`
  (ADR-0027). Since Atlas pulls Granola itself (ADR-0034, 2026-10-14) the
  same meeting arrives twice, once per provider. In the maintainer's vault, 8
  days held both, and on the day of the request two meetings did, each with
  the same attendees, starts a few minutes apart, and the Gemini copy's start
  marked approximate (`start_approximate`). Nothing linked them. A copy is
  already archived and stamped `atlas_duplicate_of: [[original]]` when the
  provider and id match (ADR-0027, P28-04), and nothing downstream runs on a
  copy.
- **Who is "me" rests on a name.** The vault has no Person note for its
  owner, and the owner's email addresses live only in Granola's settings
  (`granola_self_emails`; ADR-0034 calls them `selfEmails`). `isOwnerAttendee`
  and `itemOwner` match the profile name (ADR-0024). That is enough to
  propose, and is one unset field away from every item becoming "waiting on"
  the owner's own name; making tasks needs more (below).
- **Everything runs on one Mac**, the named one (ADR-0025). ADR-0035 shows
  a Mac that is not named a banner and a one-click claim; it does not move the
  automations by itself. This record assumes one Mac runs it at a time.
- **The meeting contract keeps text before the first section alone**
  (`splitMeetingSections`), and refuses an unknown `##` heading.
  Provider text in `## Summary`, `## Notes`, `## Provider next steps` and
  `## Transcript` is the person's and the provider's.
- **The step's machinery already exists**: `ModelProvider` to the Claude Code
  CLI with its own tools off, running as the person (ADR-0021); the rule's
  handled ledger, hourly cap, dry run, Run now, Undo last run and Activity
  (ADR-0028); `writeStamp`, which refuses a note with unsaved typing or one
  changed since it was read.

## Decision

**We will post-process a meeting with one declared automation rule, "After a
meeting", whose Claude step writes a marked summary block at the top of the
meeting and makes the owner's own action items into tasks, linked both ways,
and we will link a meeting recorded by two providers as one meeting and a
copy.** The rule is written only when the person says yes to one setup offer;
nothing is written into a vault without it (ADR-0028).

### Where it runs

Imports and linking are the import (ADR-0027). The summary and the tasks are a
rule on the stamp's version, so they run once, on the linked and corrected
meeting, and **never on a copy** (rules hear `imported` only). They run on the
automations Mac (ADR-0035). The step's output kind is a new `meeting-digest`,
`{ summary, key_points[], items[] }`, registered beside `meeting-items`, which
stays registered; the preset moves to `meeting-digest`. A long meeting is
read in parts as `meeting-items` is, plus one "reduce" ask over the parts'
summaries. **The step's own budget, stated once:** at most **10 asks per run
in all, the reduce ask included** (so at most 9 parts; a longer transcript is
cut between turns and the log says so), and one 10-minute deadline. It has
its **own hourly allowance of 30 asks**, one allowance for the whole vault
shared by every rule that declares the step (amended with #179), counted
apart from the 20 runs an hour that ADR-0028's rules share, so a backlog cannot spend the shared cap or
be starved by it. Both numbers are constants.

**The model's answer is kept and reused.** The answer to a meeting, parsed and
validated, is stored with the rule's handled ledger entry for **meeting plus
transcript digest** (`meeting:<provider>:<id>:transcript:<digest>`; bounded by
the answer's own limits: 150 words, 6 key points, 25 items). A retry, Run now,
a second write after a refusal and a catch-up **reuse it and never ask
again**. A new ask is made only when the transcript's digest changes. The
answer is judged again by the domain each time (owner, confidence, today's
date), so a changed profile or vocabulary changes what is done with the same
answer, never what is asked.

### The summary block

- **Where, and how it is marked.** At the top of the body, before the
  provider's `## Summary`, as text that belongs to no section. Not a `##`
  heading, which the section reader refuses. The block is a callout between
  two comment markers:

  ```markdown
  <!-- atlas:summary v1 -->

  > [!summary] Summary by Claude (claude-sonnet-5-5, 2026-10-14)
  > Larkspur Payroll and the platform team agreed to ship the cache behind a flag.
  >
  > **Key points**
  >
  > - …
  >
  > **Action items**
  >
  > - Flag the cache before Friday: Tobias Fenn (turn t0002)
  > - Send Mara the renewal contract: you (a task was made)
  >
  > <!-- /atlas:summary -->
  ```

  **Plain bullets, no checkboxes, no wikilinks.** A `- [ ]` inside the block
  would be read by the checklist machinery as the person's own to-do, and a
  `[[link]]` is rewritten by renames and archives (ADR-0003, ADR-0004). So the
  block contains neither: a turn is named by its id as text, and the tasks are
  reached through the meeting's `tasks` property, not from the block.

  Frontmatter, written in the same write, after the `atlas_import:` line like
  the other stamps: `atlas_summary_digest` (digest of **the block only**, as
  written), `atlas_summary_of` (digest of the transcript it summarised) and
  `atlas_summary_model`. The first is how an edit is detected, and it covers
  nothing outside the markers; the second, how an unchanged transcript is
  skipped.

- **Shape and size** (Q8, default): a summary of at most 150 words, at most 6
  key points, and the action items with their assignees, the whole block under
  about 1,500 characters. Longer is cut and the log says so. The domain
  enforces it; an answer with a bad summary but good items keeps the items and
  logs the summary as dropped.
- **Model** (Q9, default): a cheaper one, **Sonnet**, because the step runs
  unattended on every meeting and a backlog can be many asks. A rule may carry
  `model:` to name another, the chat's included.
- **Never over the person's words.** The block is replaced only between its
  own markers, and only when its digest equals the recorded one. An edited
  block, a missing closing marker, two blocks, a marker version the code does
  not know, or a block inside a code fence is **refused**: nothing is written
  and the new summary lands as a proposal ("Replace the summary") instead. The
  provider's `## Summary`, the person's `## Notes` and the transcript are never
  touched. The write is also refused when the note has unsaved typing in a pane
  or has changed since the step read it (`writeStamp`'s rules).
- **One meeting write, tasks first.** The step plans everything, makes the
  tasks, and then writes the summary block, its frontmatter keys **and** the
  meeting's `tasks` relation in **one** write to the meeting, guarded by the
  mtime and the block's digest read at the start. There is no second write
  that could race the person's typing. If that write is refused because the
  person edited the meeting, the summary and the relation are **retried
  later from the stored answer**: no new ask, and no new tasks (their
  `atlas_item` is found).
- **Marked** in the file (the callout's title and the frontmatter), in Activity
  ("Summary written by <model> in 41 s; 2 tasks made, 3 items listed, 1
  proposal") and in the rule's log.
- **Undo** is the rule's "Undo last run" (ADR-0028): the block and its keys
  are removed when the digest still matches — or, when the run replaced an
  earlier block, that block and its keys (logged with the run) are put back —
  and the tasks it made are trashed when unchanged. A run that made tasks and
  wrote no block is still the last run. Each meeting is written first, then
  its tasks trashed; a meeting that refuses leaves its tasks too. A logged
  task is trashed only when it is a task, in the task home folder for the
  run's day, citing a meeting the run read (A25-01). Term corrections are
  recorded against the body without the block, so the block never stops
  their undo.

### Action items become tasks, for the owner only

The decision about what becomes a task is made in the domain, **never by the
model**. The owner is decided from **the cited turn's speaker** and the
vault's `selfEmails` and profile name; the model's "You" is only a hint that
may agree with it. Where the speaker is unnamed or the hint and the speaker
disagree, the item is a proposal, not a task.

| Owner                    | Confidence                       | Outcome                                                                                                                                                                                             |
| ------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the person (`self`)      | high, medium, with no domain cap | **A task is made now**, `status: inbox`, `due` when said and not in the past, `source` = the turn's block link, `meeting` = the meeting, `atlas_item` = key                                         |
| the person, capped       | any                              | **A proposal.** A cap is `spokenByAnother` (the cited turn was spoken by someone else), an unnamed speaker, "we" or "you and others", or a mixed-up kind. These items stay proposals even at medium |
| the person               | low                              | A proposal, as today                                                                                                                                                                                |
| another person or a name | any                              | Listed in the summary block with the assignee, and a `waiting` proposal as today. No Waiting task is made.                                                                                          |
| ambiguous or unknown     | any                              | A proposal (an Inbox task with an empty `waiting_on`), as today                                                                                                                                     |
| a decision               | any                              | A proposal. A decision is never made into a note without a click.                                                                                                                                   |
| a follow-up              | any                              | Goes through owner resolution like any other item; it is a task only if the owner is the person, with the same caps                                                                                 |

- **The default confidence floor is medium** (Q4), applied after the caps
  above. It is one constant. A
  missed item is the problem he named, so medium errs toward a task he can
  delete over an item he never saw. The first real meetings are the test of
  that choice (see Consequences).
- **The task lands in `inbox`** (Q3, default), not `next-action`: a task made
  by a model goes through clarify first (ADR-0029). The task rules hold: ~~Waiting
  needs `waiting_on`,~~ _(Amended 2026-10-14, #202: Waiting never needs
  `waiting_on`.)_ and the use-case goes through `createNote`.
- **Others' items** (Q5, default): listed in the summary with the assignee,
  plus proposals as today. Making Waiting tasks for them is a rule setting,
  off.
- **Who is "me"**: one source, the vault setting `selfEmails`, beside
  `profileName` (ADR-0024; amended there), filled by the person in Settings →
  Profile and in the setup. This record does not name, ship or default any
  address. `granola_self_emails` stays **read as an alias** while `selfEmails`
  is empty, so the Granola pull and this rule cannot disagree. Granola's `me`
  mapping is compiled into n8n's Code nodes, so the n8n workflow's OPTIONS
  must carry the same addresses, byte for byte (ADR-0034); a changed value is
  changed in both. **With neither `selfEmails` nor a profile name, the step
  makes no tasks** and shows a loud Inbox warning, "Atlas can't tell which
  action items are yours: add your emails", on every run until fixed. It is
  never silent. The summary and the proposals are still made.
- **Identity key.** A task's identity, `atlas_item`, is the **primary
  meeting's identity** (provider + id), **the cited transcript block id** and
  **the resolved owner**: not the model's title, whose wording changes from
  one answer to the next. Where two copies of a meeting exist (before the
  sweep archives one), tasks key on the **primary**, the first-imported copy.
  It is written on the task and looked up across the vault **and the
  Archive** before a task is made. Before creating, the step also skips an
  item when **a task linked to the meeting already cites the same block**,
  which covers a task the person made and linked by hand. A re-run, Run now, a
  second write, a second Mac after a conflict, or Accept of a leftover
  proposal for the same item makes nothing twice, and a task ticked done and
  archived is not made again. (Proposals keep their own id, which includes the
  title; the two are reconciled by "Two sources of truth" below.)
- **Linked both ways.** Task to meeting: `source` (the block link, as Accept
  writes it) and a `meeting` relation. Meeting to task: `meeting.tasks`, joined
  by the same use-case Accept uses, extracted first into one place
  (`makeTaskFromMeeting`) so there is one way to make a task from a meeting
  item. The person's Task type gains `meeting` and `atlas_item`, and the
  Meeting type gains `tasks`, `decisions` and the summary keys, all offered in
  one previewed yes.
- **Backfill** (Q6, default): the rule's `which` bounds it to meetings dated in
  the last 14 days (`@-14d`, the query language's moving date). **A backfilled
  meeting makes proposals, not tasks**: only a meeting that arrives after the
  step is enabled makes tasks directly, so enabling it cannot fill the Inbox
  with two weeks of guesses at once. The run that tells them apart compares
  the meeting's arrival with the rule's own file, as catch-up already does
  (ADR-0028). A **due date in the past is not set**: it is dropped and the
  task's body says what was said. Older meetings are summarised and mined only
  when the person runs the rule by hand with a wider query. The 15 old
  Granola meetings that were never stamped get linked and corrected, not
  mined.
- **Work meeting text through Claude Code** (Q11, a default: yes) adds no new
  recipient: the text already passes through n8n, GitHub and the chat
  (PLAN.md section 11). The maintainer did not answer it; it is recorded as
  a default and he can say no.

### Cross-provider copies are linked, not merged

A meeting from a second provider is a copy of one the vault already holds when
all of these hold, tried against meetings with the same `date` and a different
`provider`, excluding notes stamped `duplicate` or `error`, conflict copies and
**anything in the Archive** (an archived meeting is never a candidate):

1. **The time windows overlap.** A window is the half-open `[start, end)`, so
   back-to-back meetings do not overlap: `end` when given,
   else `start` plus the transcript's length, else `start` plus 30 minutes. A
   start marked approximate widens its window by 20 minutes each side.
2. **The attendees overlap**: Jaccard similarity of 0.5 or more over attendee
   emails, lower-cased, group addresses left out, **the owner left out** (by
   `selfEmails` or name). **At least one shared attendee other than the owner
   is required**, so two meetings with only the owner, or two different 1:1s
   with the owner, never match. When either side has no emails, names are
   compared under the same requirement.
3. When more than one holder matches: title-word overlap, then the nearest
   start.

**The thresholds (0.5, 20 minutes, 30 minutes) are provisional starting
values, not findings, until spike S1 has run.** They were checked by hand against two real pairs and one
look-alike pair, and they are set before any file is archived by a spike
(S1): the rule runs read-only over all of the vault's meeting headers, the
person looks at the pairs it finds, and the values chosen are written here
**before this record is accepted**. A change to them later is an amendment,
since they decide which meeting is archived.

What happens to a match is what already happens to a same-provider copy
(ADR-0027): **the first one imported is the original**; when both arrive in
one run, the existing path order decides. The copy is archived (not deleted),
stamped `duplicate` and `atlas_duplicate_of: [[original]]`. The link is
one-way; the original shows its copies through backlinks. Nothing runs on the
copy, so the summary and the tasks are made once. The link is the existing
property, as the maintainer asked.

A Granola copy can hold the person's own typed notes in `## Notes`. By default
(Q7) it is archived like any copy, one click away from being brought back.
Meetings already imported as two originals (before this rule, or while two Macs
differed) are not touched on arrival; a previewed, undoable sweep ("Find
duplicate recordings") lists the pairs and archives the copy on a yes. It does
not merge tasks already made from both.

### Re-running and idempotency

| Re-run of                                  | Guard                                                                                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The import on a stamped file               | `atlas_import_outcome` is never judged again (ADR-0027)                                                                                                                            |
| A cross-provider match on an archived copy | The copy is stamped `duplicate`; the original's holders include it                                                                                                                 |
| The Claude step on the same words          | The rule's handled ledger, keyed by the **transcript section's digest** (`meeting:<provider>:<id>:transcript:<digest>`), which also holds the stored answer; every retry reuses it |
| The summary write                          | `atlas_summary_of` equals the transcript digest: skipped without asking the model; `atlas_summary_digest` guards edits to the block                                                |
| Task creation                              | `atlas_item` (meeting, cited block, owner) looked up in the vault and the Archive, and a task linked to the meeting that cites the same block                                      |

**The ledger's key changes.** ADR-0028 keys a meeting by its **body**
digest (`meeting:<provider>:<external_id>:body:<digest>`), so Accept's
frontmatter writes already leave it alone. The body is also where this step
writes: the summary block, and the person's edits to `## Summary` and
`## Notes`, change the body's digest, so under the old key the rule would ask
again about unchanged words. Under the new one, only an edit to the transcript
section is "new words". The fixtures in the repo's tests change; nothing in
the maintainer's vault was answered under the old key.

### Failure modes

| Situation                                                                      | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code not installed or logged out on the Mac that runs it                | Import and linking are unaffected. The run fails with the fix-it line and backs off (doubling from a minute, at most 15 minutes, `unavailableBackoffMinutes`); the provider's status is asked again at each tick, and the run is retried as soon as it is ready, at the backoff's end, and at the next open (amended 2026-10-29, #182). The Inbox row says "summary pending" and why. A Mac that is not named and claims "Process here" reruns the catch-up at once (ADR-0035). |
| The answer does not parse, has over 25 items, or misses the 10-minute deadline | The run fails, nothing is written, the log records the asks. It settles, with no backoff and no news held; Run now asks again (amended 2026-10-29, #182).                                                                                                                                                                                                                                                                                                                       |
| A task write fails after some tasks were made                                  | Everything is planned before the first write, the tasks are made first, and the summary block with the `tasks` relation is written **last, in one meeting write**, so no summary lists a task that does not exist. Tasks made stay (logged); `atlas_item` makes the rest once on retry, from the stored answer.                                                                                                                                                                 |
| The person edits the summary block                                             | Its digest (over the block only) no longer matches: it is never rewritten. A later summary (the transcript changed) is a proposal.                                                                                                                                                                                                                                                                                                                                              |
| Neither `selfEmails` nor a profile name is set                                 | No tasks are made. The summary and proposals are. The Inbox says "Atlas can't tell which action items are yours: add your emails" until fixed.                                                                                                                                                                                                                                                                                                                                  |
| The meeting is edited, or typed in, while the step runs                        | The write is refused (`expectedModified`, or the pane's unsaved state). The tasks stay; the summary and the `tasks` relation are retried from the stored answer, with no new ask and no new tasks.                                                                                                                                                                                                                                                                              |
| A false match archives a real meeting                                          | The copy is archived, not deleted; Activity names the reasons; **unarchiving a copy this rule archived restamps it `imported` and removes its `atlas_duplicate_of`**, so the step runs on it like any arrival (ADR-0027's "unarchive carries the stamp" gets this exception). The spike sets thresholds first.                                                                                                                                                                  |
| Copies arrive on two Macs between syncs                                        | Each is let in on its Mac; after the sync both are originals and the sweep lists the pair. Only one Mac is named at a time (ADR-0035 adds no automatic hand-over), so this needs the person to claim on one Mac between syncs: rare. Tasks key on the primary, first-imported copy; tasks already made from both are not merged.                                                                                                                                                |
| 28 waiting meetings and 600 old ones when the rule is saved                    | The rule hears meetings written after its own file (ADR-0028); the 14-day `which` bounds the rest; the backfill makes proposals, not tasks; the per-run cap of 10 asks and the vault-wide hourly allowance of 30 asks for the step hold.                                                                                                                                                                                                                                        |

### Amended 2026-10-15 (#183-#186)

- **What the block lists.** Besides the summary, the key points and the
  action items, the block lists the meeting's **Decisions** (the answer's
  `decision` items, by title) and up to four **Open questions** (a new
  optional `open_questions` key of `meeting-digest`), as the maintainer asked
  on 2026-10-15: what he needs at a glance. The cut order when the block is
  too long: open questions, action items past the third ("and N more"),
  decisions past the second, key points past the second, then the summary.
- **The closing marker stands outside the callout**, on its own line after
  a blank one, not as the callout's last line as the example above shows:
  inside the quote, the editor reads the whole callout as opaque code.
- **A rule saved with `output: meeting-items` and `apply: mine`** (the #179
  preset, and the maintainer's vault) is read as `meeting-digest`: the
  declared step always summarises. Its file is not rewritten, since when it
  was saved is what tells an arrival from a backfill.
- **The reduce is planned per meeting.** A meeting read in parts takes its
  reduce ask out of the same 10, so a run never starts parts it cannot merge;
  the budget's separate `reservedPerRun` is gone.
- **A refused block is kept, not proposed.** An edited, broken or removed
  block is left as the person has it and the run says so (Activity, the
  rule's log, the meeting's summary state `edited`); the tasks are still
  joined. The "Replace the summary" proposal is a follow-up, not built here.
- **With unsaved typing in the meeting**, no task is made from it either
  (`makeTaskFromMeeting` refuses, as Accept does): the run fails, keeps its
  answer, and the retry makes the tasks and writes the summary without
  asking again.

## Alternatives considered

- **Keep proposals only (the status quo, ADR-0028).** Honours "AI proposes,
  James accepts" and every existing test. Not chosen for the owner's own items:
  the problem is items that are missed, a proposal that is never opened is a
  missed item, and the preset was never enabled in the first place. The cost is
  a model writing into his files, accepted below. It stays the answer for
  everything not his (others' items, low confidence, decisions, a refused
  summary).
- **Make tasks at high confidence only.** Fewer wrong tasks, more missed
  items. Not chosen as the default because a missed item is what he is trying
  to stop; it is the same constant if medium proves noisy.
- **Make `next-action` tasks.** Skips clarify. Not chosen: a model's reading of
  a transcript is an input to clarify, not a decision.
- **Make Waiting tasks for other people's items.** It is the other half of
  "missing action items", and it fills the person's list with other people's
  work on a model's attribution. Off by default, available as a setting.
- **Put the summary in a separate note, linked from the meeting.** Leaves the
  person's meeting untouched and removes most of this record's deviation. Not
  chosen because he asked for it at the top of the meeting, and a separate note
  is one more page to open.
- **A summary under a `## Atlas summary` heading.** The section reader refuses
  unknown `##` headings, and the contract's sections are the provider's.
- **A frontmatter `summary:` property.** Short, never mixed with the person's
  text, and invisible at the top of the note, where he asked for it.
- **Duplicates: keep `provider` + `external_id` only.** The status quo; it
  leaves the same meeting twice and every action item made twice.
- **Duplicates: match by title.** Providers title the same meeting
  differently, and two different standups share a title.
- **Duplicates: a shared identifier.** The contract carries none across the
  two providers (ADR-0027's frontmatter), so there is none to match.
- **Merge two recordings into one note.** Out of scope: it fights the
  corrections and block citations (ADR-0034), and a merge cannot be undone as
  cheaply as an archive.
- **Link a copy two ways, or keep it in place.** A new meaning for the
  `duplicate` stamp that touches the import's "settled" rule and the Inbox
  query. Kept as the alternative if archiving a Granola copy hides his typed
  notes too often (Q7).
- **Auto-create Decision notes** (Q12, default: they stay proposals). A
  decision is a claim about what was agreed, and a wrong one is more costly
  than a wrong task.

## Consequences

Easier:

- His own action items are in his task list the same hour, linked to the
  citing turn, without a click. His meetings begin with a short summary and a
  list of who owns what.
- A re-run, Run now, a second Mac and Accept after the fact each make nothing
  twice.
- A second recording of the same meeting is recognised and linked, and does not
  make the tasks twice.

Harder, and what it costs:

- **A model writes into his notes without a click.** This is the deviation, and
  it is not free. The block can be wrong, and a task made at medium confidence
  can be the wrong item, the wrong owner or the wrong due date. The marker, the
  digest, the callout title, the frontmatter, Activity and Undo make it visible
  and removable; they do not make it correct. Whether medium-confidence items
  are right often enough is **not known**; the first weeks of real meetings are
  the test, and the floor is one constant.
- **A wrong "self" is likely when `selfEmails` is empty**, and the setup can
  only ask; with neither it nor a profile name, no task is made (above). A
  name that two attendees share, a transcript with unnamed speakers, a turn
  spoken by someone else, or "we" stay proposals; the domain's caps treat each
  so, and its tests carry them.
- **A wrong match archives a real meeting.** It is reversible and visible, and
  the thresholds are unproven until the spike has run.
- **The block's text syncs to GitHub** with the meeting, like the rest of it.
- **Plan limits.** Each ask counts against the person's Claude plan: about 10 to
  60 thousand input tokens per hour of meeting, 1 to 10 asks per run (the
  step's own cap, reduce included; an estimate from the transcript sizes, not
  a measurement). Sonnet by default keeps that cheap.
- **A re-ask is made only when the transcript changes**, and then the marked
  block is stripped from the text the model is shown, so it never summarises
  its own summary.
- **The ledger's key changes**, so any rule answered under the old key would
  ask again once. None exists in the maintainer's vault. The ledger also grows
  by the stored answers.
- **Two sources of truth for an item for a while.** A proposal and a task can
  exist for the same item if the proposal was made first; Accept is then refused
  as "already made" and the proposal archived.
- **The backfill window is a guess** (14 days, `@-14d`); it only makes
  proposals.
- **Cost to reverse: moderate.** Removing the rule stops all of it. Summary
  blocks can be removed by their markers; the tasks stay, being ordinary notes
  with `atlas_item` and `meeting` on them; the keys on the person's types stay
  until he removes them. Archived copies are restored by unarchiving. Undo last
  run does the latest run only.
- **Unknown, to be settled in the tickets:** where the Inbox's "offer these
  keys" code lives (ADR-0027 says it exists); whether the rule can name `model:` without a host change (the host's
  argument shape takes any non-empty model).
- **Status.** Proposed; accepted when the tasks and the summary have landed and
  the spike has fixed the thresholds above.

### Defaults taken

The maintainer decided the requests at the top; he did not answer the plan's
other questions, so these defaults are recorded **as defaults, not decisions**,
and any of them is a change of one constant or one setting.

- **Q3**: tasks land in `inbox`.
- **Q4**: a task is made at medium confidence and above; low stays a proposal.
- **Q5**: others' items are listed in the summary and proposed; no Waiting tasks.
- **Q6**: the backfill covers the last 14 days and makes proposals; older by Run now only.
- **Q7**: a copy with the person's typed notes is archived and linked.
- **Q8**: the summary is a callout at the top, 150 words at most, with key
  points and the action items with assignees.
- **Q9**: Sonnet, with `model:` available.
- **Q10**: not answered, and not a default value: the person's email addresses
  are a vault setting (`selfEmails`) that he fills in. None is recorded here.
  Without it and without a profile name, no task is made.
- **Q11**: yes, work meeting text goes through Claude Code unattended (a default, not his answer).
- **Q12**: decisions stay proposals.

## Amendment: only the owner's real commitments reach them (#226, 2026-10-15)

**Why.** Measured on the maintainer's own vault (two weeks, 189 items the two
meeting rules made, each labelled against its transcript), only about one in
five was a real commitment of his. Most were other people's work, correctly
attributed and still proposed (Q5), and the rest were status updates, ideas
and topics discussed. He called it a huge time sink. Precision was the
problem, not who the owner is: his profile name already told him apart.

**What changes.** The step decides more, and shows less:

- **Q4 is now high.** `TASK_CONFIDENCE_FLOOR` is `high`: a task is made only
  for the owner's own, uncapped item said plainly. A task he never asked for
  costs him more than one he reviews once.
- **One review proposal per meeting.** What he should still see — his own
  items at medium, his items a cap holds back at medium, a waiting-for he
  asked for, a decision he took part in that the model is sure of — goes into
  one proposal (`meetingReview`): accepted, it is one Inbox task whose body is
  a checklist, each line linking its turn. Never one card per item.
- **Left out** (`left-out`, counted in the log): anything below medium
  (`REVIEW_CONFIDENCE_FLOOR`), someone else's item he did not ask for (Q5 is
  reversed: others' items are no longer proposed), an item nobody or several
  people could be named for, and a decision he took no part in.
- **Asked for, and took part, are read from the transcript.** The model may say
  `asked_by_owner`; the domain keeps it only when the owner spoke in the
  exchange the item cites: the cited turn or one of the `EXCHANGE_TURNS` (6)
  before it. A decision is kept on the same test. The model's word alone
  never keeps an item.
- **The prompts say what is not an item**, with made-up counter-examples. A
  prompt note still holding an earlier version's exact words (known by digest)
  is rewritten to the current one when the vault opens on the automations
  Mac; one the person edited is theirs and is left alone.
- **No owner, no tasks, said loudly (#181).** With no profile name and no
  address, nothing is made a task, the run's log warns on each run that reads a
  meeting, and the Inbox says so until it is fixed.
- **The owner's addresses need no button.** With no `selfEmails` saved, the
  owner's Person-note addresses are used everywhere ownership is decided (they
  already were in item ownership; now also for the Granola mapping and
  linking), and Settings → Profile says so. The field saves as it is typed.
- **An offered cleanup** lists the tasks the step made that fail these rules
  from what the task and its meeting still hold — the cited turn not the
  owner's — and archives the ones he leaves ticked, unless one changed since
  he was shown it. One he unticks is marked `atlas_item_kept` and never listed
  again. With no owner known nothing can be judged: it lists none and says
  why. How
  sure the model was is not kept on a task, so one made at medium under the
  old floor cannot be told apart and is not listed.

- **The summary lists what reaches the owner, and nothing left out.** Its
  action items are the owner's (a task, or in the review) and what he asked
  others for (a waiting-for in the review); its Decisions are those the review
  carries. Every item the decision leaves out (`left-out`) is listed nowhere,
  and the log's `listed` does not count it. The log line's optional parts
  (`listed`, `summary`, `left out`) come in that order; lines from before
  either part still read.

**Measured.** See the PR for #226: on the same labelled meetings, re-asked
with the new prompt and decided by these rules.

**Cost.** Recall: items the model is unsure of, or that are spoken by an
unnamed speaker, no longer reach the owner. Decisions are the largest loss;
see the PR's numbers. Reversing any part is one constant or one branch.
