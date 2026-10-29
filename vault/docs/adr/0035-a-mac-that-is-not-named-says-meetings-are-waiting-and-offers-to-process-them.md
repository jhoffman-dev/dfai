---
type: adr
id: ADR-0035
title: A Mac that is not named says meetings are waiting and offers to process them; automatic hand-over is deferred
status: proposed
date: 2026-10-14
---

# ADR-0035 — A Mac that is not named says meetings are waiting and offers to process them; automatic hand-over is deferred

## Context

Import on arrival, linking, correction and every automation that reacts to a
meeting run on **one Mac**, the one the vault's settings name
(`automationsMac`, ADR-0025; `runsAutomationsHere` in
`packages/domain/src/sync/sync-rules.ts`). ADR-0027 (P28-04) says the same
of the import: "Only the Mac that runs the automations writes stamps…
Another Mac does nothing, and loses nothing by it." ADR-0034 repeats it for a
pulled Granola meeting: it "is settled when sync reaches that Mac".

On 2026-10-14 that rule was found to be the reason nothing post-processed the
maintainer's meetings. He works mainly on one Mac. The vault named another.
On the Mac he used:

- Every sync commit in the vault came from it, and its Activity log held
  Granola pull lines and no meeting-import line at all. A Mac that is not
  named drops what it hears without a word (`meeting-importer.ts`: "One that
  is not drops what it hears; nothing is lost by that").
- 28 meeting files under `Inbox/Meetings/` had no `atlas_import_outcome`
  stamp: 13 from the last two days, and 15 older Granola meetings that this
  Mac's own pull had written. None was linked or corrected.
- Nothing told him. Days passed before he looked.

His position on 2026-10-14: a workflow that requires opening a particular Mac
is unacceptable ("that would be a HORRIBLE workflow"). He did not answer the
plan's question Q2, whether a take-over should be automatic or only a button.
The first draft of this record took automatic hand-over as the default. The
review and adversarial passes found it unsafe to ship in this phase (see
"Automatic hand-over: considered and deferred"), so **the default taken is the
button**: it removes the silence and the need to open a particular Mac, and
costs one click.

Why one writer at all (the forces that still hold):

- Two Macs writing one file between syncs is a git add/add conflict with
  different bytes. `settleConflicts` keeps this Mac's file and files the
  other's as `… (conflict from <Mac>).md`, which the import never judges
  (ADR-0025, ADR-0027). Identical bytes merge cleanly.
- The import's steps (validate, find holders, link, correct, stamp) are
  deterministic given the same vocabulary and files, so a double run of them
  costs at most a conflict copy of a proposal note or an archived copy
  stamped across midnight (ADR-0027, P28-04, already accepts this).
- A rule's Claude step (ADR-0028, and the summary and tasks of ADR-0036) is
  **not** deterministic: model text and task note names differ per run. A
  rule's log and its handled ledger are synced notes written for one writer.

What is already built and reused: the claim itself. A write of
`automationsMac` to `.atlas/settings.md`, which the other Mac reads on its
next sync and stands down. Settings → Sync can already move the automations
to this Mac "when the person asks" (ADR-0025).

## Decision

**We will keep one named Mac running the automations, as today, and make every
Mac that is not named say, in the Inbox and in Activity, that meetings are
waiting for the named Mac, with a one-click "Process here" that names this Mac
(the existing claim).** No Mac takes the automations over by itself in this
phase.

Four parts:

1. **A Mac that is not named says so.** The Inbox page shows a prominent
   banner line, "N meetings waiting for <Mac>", with a **"Process here"**
   button. Activity gets a warning once per sync while it holds, "N meetings
   are waiting for <Mac> to process them". Today the drop is silent. The
   waiting count is shown only on a Mac that is not named. The **named** Mac
   shows one line instead when its own step is failing (for example "Claude
   is unavailable on <Mac>: summaries and tasks are pending"), so a failing
   step is never silent either.
2. **"Process here" is the existing claim.** It writes `automationsMac` (this
   Mac's id and name) through the settings writer Settings → Sync already
   uses. The other Mac reads the new value on its next sync and stops
   (`runsAutomationsHere`). The button is **disabled** while this Mac's sync
   is paused, is failing, or has not completed a pull since this app launched
   or this Mac last woke (part 4); the banner says which. Otherwise a Mac that
   cannot push would claim in settings it cannot share, and both Macs would
   believe they are named. Claiming also **catches up** (below).
3. **What "waiting" counts.** The sum of two things, shown together:
   - **Unimported meetings**: files under `Inbox/Meetings/` with no import
     outcome stamp, **excluding** sync-conflict copies
     (`… (conflict from <Mac>).md`, recognised by `conflict-copy.ts`, which
     the import never judges, ADR-0027) and **excluding** files that cannot be
     read. A conflict copy is the person's to merge; counting it would make
     the banner permanent, and a claim cannot clear it.
   - **Imported meetings whose post-processing has not completed**: the
     summary or the tasks are still pending in the rule's handled ledger
     (ADR-0036). This is what makes a named Mac whose Claude is unavailable
     visible: it stamps every meeting, so the first count alone would stay at
     zero while no summary or task is ever written.
4. **Every Mac, named or not, acts only on fresh sync state (D1).** A Mac runs
   the import and the Claude step only after **a pull that completed since
   this app launched or since this Mac last woke**, and only if **it is still
   the named Mac after that pull**. If B claims while A sleeps, A wakes,
   pulls, sees it is no longer named, and runs nothing; the importer acts on
   no meeting from that pull. The same two conditions judge the waiting count:
   - **Gate 1, a pull completed after the file arrived**: the last completed
     pull on this Mac finished later than the file's modified time here.
   - **Gate 2, the Mac has launched or woken since**: that pull also finished
     later than the last launch or wake/resume of this Mac. The wake signal is
     new in this ADR and **unproven** (see Unknown, below); no fixed wait
     stands in for it.

   The existing "synced this session" flag (`use-granola-pull.ts`,
   `syncedThisSession`) is **not enough for either gate**: it turns true once
   and stays true across sleeps, which is exactly when the named Mac's stamp
   is in flight. Until both gates hold the banner says nothing about counts
   rather than guessing. A vault that does not sync is unchanged: it has one
   Mac.

   _(Amended 2026-10-14, #174.)_ How the gates are applied:
   - **Both gates judge the import and the Claude step**, not only the
     waiting count. The import applies gate 1 **per file**: a meeting file
     modified here after the last completed pull finished is not imported
     until the next pull completes, and so is not heard by a Claude step
     either. A Claude step applies gate 1 to the notes it reads.
   - **Asked again right before every write.** The import asks before each
     file's first write and again before its stamp, judging the file by when
     it was modified as the run first read it. The Claude step asks before it
     asks Claude, and again after the model's turn, before it writes its
     proposals, notes, tasks, log or ledger. Shut at any of these, nothing is
     written for that file or run, nothing is said, and it is held for the
     next pull. Once a run has written something, its log records it.
   - **What counts as a pull.** A sync that completes, and a look at GitHub
     that finds nothing to bring in, complete a pull. A sync that fails, or a
     look that finds other Macs' changes, voids it. A look that fails changes
     nothing.
   - **Settings that cannot be read run nothing.** In a vault that syncs,
     `.atlas/settings.md` missing, unreadable (permissions, I/O, invalid
     UTF-8) or with frontmatter that does not parse, after a pull or when read
     before acting, shuts the gates. Activity says so once. A readable note
     that names no Mac still names every Mac.
   - **Paused sync shuts the gates.** While sync is paused on this Mac,
     nothing is imported and no Claude step runs. Settings → Sync and
     Activity say that automations wait.
   - **Clock and on-open Claude rules are gated too**, at fire time and before
     each write. A schedule that comes due while the gates are shut runs once
     a pull completes; a rule run by hand is not gated.
   - **A vault that is not a git repository**, including one on a Mac without
     git, counts as not syncing, so the import runs without waiting.
   - **A file the import cannot settle** (a conflict copy, an unreadable
     file, a failed write) is said in Activity once a session, and again only
     if its content changes. Without this, the catch-up after every pull
     would repeat the line each time.

**What the banner says (parts 1 and 3).** _(Amended 2026-10-28, #175.)_
Before the gates hold (the "Unknown" below) it says "Meetings may be
waiting for <Mac>: they are counted after the next sync.", or, while sync is
paused here, "… they are counted once sync resumes." It gives a number only
while a pull that started since the last launch or wake has completed and
sync is not paused. A wake or a pause seen since that pull takes the number
away again, though no new pull has completed. A file modified here after
the pull is left out until the next one. During a pull the line stays as it
was. It shows nothing when none waits, when no meeting file lands in the
vault at all, while the settings cannot be read (the Inbox already says so),
and in a vault that does not sync. The Mac is named by
`automationsMacName`; one the settings keep no name for is "the Mac that
runs the automations", never its id.

Unimported meetings are counted wherever the import would settle them:
`Inbox/Meetings/` and the month folders under `Meetings/` (#214) whose files
declare the contract. A sync-conflict copy is never counted, whatever the
other Mac is called; its name is recognised for any Mac label, brackets
included (#627). A file whose frontmatter does not read counts as one that
cannot be read. The count uses the import's own listing and reads, only on a
Mac that is not named. The folders are listed once per vault opened, and each
file is read once, eight at a time. After that, news that names a meeting
file has that file alone read again, and a removed one is forgotten. Each
judgement tallies what is known against the pull, so a pull that brings
nothing (a look at GitHub, about once a minute) lists and reads nothing. In a
vault that does not sync, or while the settings cannot be read, nothing is
listed or read.

Activity warns at most once per distinct count in a session for the vault.
A drop that deferral alone explains is not news: files edited here are left
for the next pull and come back then.

**Catch-up on a claim.** The import's catch-up needs no change:
`use-meeting-import.ts` already clears its `caughtUp` while this Mac is not
the importer and reruns the catch-up when it becomes the importer, so a claim
settles every unstamped file at once. The Claude step's catch-up
(`missedArrivals`, ADR-0028; `caughtUp` in `use-automations.ts`) is once per
vault opened and is **not** reset today. This record specifies the reset: it
clears when `scheduled` goes **false to true** for this vault, and the
catch-up reruns. That covers the button and a move made in Settings → Sync
alike; it is not tied to the button.

_(Amended 2026-10-28, #176.)_ How the claim is made:

- **One writer.** `claimAutomations` (application, `sync/`) is the only code
  that changes `automationsMac` once sync is set up; set-up's hand-over
  names a Mac only when none is named. "Process here" and Settings → Sync
  both call it, and Settings → Sync's own save writes only the timing keys.
  A test holds this.
- **Settings → Sync is not gated.** The disabled rule of part 2 is the
  button's. The manual move stays the person's own (ADR-0025).
- **In the vault's git turn, then a sync.** The claim waits for any sync or
  look under way, asks the gates (with how sync stands at that moment, not
  as last drawn), reads the settings, asks the gates again and writes, with
  no pull in between. It then syncs at once, unless sync is paused here: a
  paused Mac writes the claim and leaves it for the sync after it resumes.
- **Not yet shared until GitHub has it.** A claim is unshared while the
  settings here name this Mac, by id, and the settings on GitHub, as the
  last fetch left `origin/<branch>`, do not. It is judged from git at every
  pull that completes (a sync, or a look that finds nothing) and as the
  gates are asked, so a claim written while paused or offline, committed or
  not, is found again after a restart or after opening another vault and
  coming back (#630 attack). While it holds, the banner and Activity say
  "Process here is set on this Mac but not yet shared with <Mac>", the
  gates stay shut on this Mac (`claim-unshared`), and a look that finds it
  starts a sync at once unless sync is paused. GitHub's settings are read
  as one blob, `cat-file blob origin/<branch>:.atlas/settings.md`, a host
  shape that takes that path alone and only for the branch checked out;
  nothing lists the tree. Settings that cannot be read count as not naming
  this Mac, so nothing runs on a guess, and Activity says so once a vault
  ("Automations wait: DFAI could not read this vault's settings on GitHub
  to confirm the claim."), again only after a read has succeeded since.
  Once GitHub names this Mac the gates open, Activity says "<Mac> now runs
  the automations" (only for the vault open now; after a restart, once git
  shows the claim shared), and the catch-ups run once.
- **Settings → Sync shows its claim.** It is busy while the claim waits its
  turn, and the card says why one named no Mac (a refused write, settings
  that cannot be read, or this Mac's id not read yet).
- **Nothing written** when the settings cannot be read, when they already
  name this Mac by id (a renamed Mac is still named), or when another vault
  opened before the write's turn.
- **Two claims within one sync interval.** Both change the same key, which
  the settings merge (#233) never merges, so it is settled as every settings
  conflict is: the Mac whose sync merges keeps its own copy and pushes it,
  and the other's is copied aside. The first to push then fast-forwards and
  stands down. **The Mac that syncs second wins**; there is always one. A
  setting the other Mac only added meanwhile merges in beside the claim. The
  other Mac still running when the claim lands stands down at its next pull,
  and any step already under way stops at its next ask of the gates.

**This amends no accepted statement in a way that changes who writes.**
ADR-0025's "A Mac connecting to a vault never takes the automations from
another Mac" stays true: a person's click is not the Mac taking anything. The
amendments are to the silence (ADR-0025, ADR-0027, ADR-0034, ADR-0028 each
carry a pointer). This amendment takes effect when ADR-0035 and ADR-0036 are accepted.

### Automatic hand-over: considered and deferred

The first draft had a Mac that is not named write `automationsMac` itself
after a meeting had waited ten minutes. It is **not** taken in this phase. The
review and the adversarial pass found holes that a future design must solve
before it is reconsidered:

| Hole                         | What goes wrong                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conflict-copy ping-pong (H3) | Under the old automatic trigger (an unstamped file in `Inbox/Meetings/`), sync-conflict copies of meetings and unreadable files, which the import never stamps, counted as work waiting. Two open Macs then took the automations from each other on every pull.                                                              |
| Pull interval (H4)           | A fixed 10-minute wait is shorter than the configurable pull interval (5 to 60 minutes). An **awake** named Mac that has not yet pulled a meeting written on the other Mac loses the automations whenever that meeting reaches the other Mac first.                                                                          |
| Paused sync (H5)             | A paused Mac keeps writing Granola files and claims the automations in a settings write it cannot push, so both Macs believe they are named. Part 2 covers the button by disabling it while sync is paused, failing or has not pulled.                                                                                       |
| Wake races (H7)              | The stale named Mac, on wake, runs its Granola and sync timers before the pull that would demote it, and the importer acts on meetings from that same pull. Part 4 covers it: nothing runs until a pull has completed since the wake and this Mac is still named.                                                            |
| Claude unavailable (H6)      | A named Mac whose Claude is unavailable stamps every meeting, so nothing counted as waiting and summaries and tasks went missing silently. Part 3 covers it by counting imported meetings whose post-processing is pending, and part 1 by the named Mac's own line. A Mac that took over without Claude would worsen it too. |

A future design must also say how a claim is undone, how a take-over is
withheld from a Mac without Claude, and how the settings file's own conflict
copies are kept out of the count. None of this is built; the record is kept so
the idea is not reinvented without its holes.

## Alternatives considered

- **Automatic hand-over after ten minutes** (the first draft). Deferred, above.
  It is the best workflow for the person and the worst on correctness; the
  button is the cheaper step that removes the silence.
- **Keep the gate and move the automations by hand (Settings → Sync) with no
  banner.** The status quo, and what the written record says. It produced the
  28 unstamped files and four silent days. Kept as the manual path; the banner
  and button are the new part.
- **Any Mac post-processes (option B in the plan): the import's steps run on
  every Mac that has synced this session, and a rule's Claude step claims a
  meeting by writing `atlas_processing: <Mac> <instant>` into the file,
  syncing, and proceeding only if its claim survives the next pull; stale
  claims (more than 15 minutes) are taken over.** It removes the notion of a
  named Mac. Not chosen because it adds an extra sync round-trip before every
  model step; claim conflicts are still possible within the same minute;
  proposal numbering, the rule logs and the ledgers would have to survive two
  writers (conflict copies in `Sync conflicts/atlas/`); and the claim lives
  in the person's files. Reversing it later is harder than anything here,
  because the key is written into meetings. **Kept in reserve**: its first
  half (every Mac runs steps that are deterministic) is one boolean to open,
  as ADR-0034 notes from the other direction.
- **A lease held in the vault (a heartbeat file the named Mac renews).**
  Needs a clock both Macs agree on and a sync before every renewal, and a
  sleeping Mac cannot renew; it fails exactly when a Mac sleeps, the case this
  record is about.
- **A hosted relay or the n8n workflow does the post-processing.** The model
  step needs the person's own Claude login (ADR-0021), which is on a Mac.
  Out of scope.

## Consequences

Easier:

- The silence is gone: a Mac that is not named says how many meetings wait,
  and for whom, on the Inbox page and in Activity.
- He does not need to remember which Mac was named. Opening the Inbox on the
  Mac in front of him shows it, and one click moves the automations there and
  processes what waited.
- Every write stays single-writer, so the rule logs, the handled ledger
  (ADR-0028) and the proposals' numbering keep the assumption they were built
  on. "A Mac that is not the automations Mac never runs Claude on a meeting"
  (ADR-0028) stays true: only a click changes which Mac that is.

Harder, and what it costs:

- **It is still one click.** The click is on the Mac in front of him, so he
  never has to go to another Mac, which is his requirement. Meetings still
  wait until he clicks or the named Mac wakes and pulls. If that proves too slow, automatic hand-over is the
  next record, with the holes above to solve.
- **A wrong count is possible.** "Waiting" relies on the two gates, on the
  stamp's absence and on the ledger. A named Mac that stamped a file but has not pushed shows as
  waiting on the other Mac until the pull after it. Pressing "Process here"
  then is harmless in the steady state (deterministic steps, ADR-0027) and a
  possible conflict copy of a rule's log if a Claude run was in flight on both;
  the ledger's recovery rebuilds from its entries and Activity warns. Rare,
  bounded and visible.
- **The wake/resume signal is new host work.** _(Amended 2026-10-14, #172,
  #174: the signal is the host's time asleep since boot, below; no fixed
  wait is reintroduced, see H4.)_
- **The named Mac now waits too.** After launch or wake it runs no import and
  no Claude step until a pull completes, and not at all if that pull shows it
  is no longer named. That delays work by up to one pull interval; it is the
  cost of closing the stale-named-Mac race.
- **A Mac that merely pulled a Granola meeting writes an unstamped file**
  (the Granola pull runs on every Mac, ADR-0034). Such files are counted once
  both gates hold, which is intended.
- **The claim is a write to a synced settings file**, so it conflicts like any
  settings write (ADR-0025: this Mac's copy wins, the other is saved under
  `Sync conflicts/atlas/`). Two people-clicks within one sync interval leave
  one winner.
- **The settings file records the Mac id and name** (as it already does). The
  claim compares ids, so renaming a Mac changes nothing.
- **Cost to reverse: low.** Remove the banner and the catch-up reset; the Mac
  named in the settings stays named and nothing written needs cleaning.
- **Unknown, to be settled in the tickets (I1-I3):** how the settings write
  and the first read behave when `.atlas/settings.md` cannot be read (the
  rule must do nothing, not guess); what the banner says on a Mac whose gates
  have not held yet. _(Amended 2026-10-14, #172, #174: settings that cannot
  be read after a pull name no Mac, so nothing runs. Gate 2's signal is the
  host's time asleep since boot (`CLOCK_MONOTONIC_RAW − CLOCK_UPTIME_RAW`),
  read at the moment of each decision. A pull counts only if it started at
  the current reading. The did-wake notification is not used for
  correctness, because dark wakes post none. Proven on one Apple-silicon Mac
  without a real sleep; the #172 recipe confirms it on each Mac.)_
- **Status.** Proposed; accepted when the banner, the claim's catch-up and the
  gates have landed, and the wake signal is proven (Phase 1 of the meeting post-processing plan).

### Defaults taken

**Q2**, not answered by the maintainer, is taken as: a visible banner and a
one-click claim, **no automatic hand-over**. The button meets his stated
requirement: he never has to go to another Mac. It is one click on the Mac he
is on, and no longer silent.
