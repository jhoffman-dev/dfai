---
type: adr
id: ADR-0028
title: An automation can be triggered by a note, and can run a Claude step that only proposes
status: proposed
date: 2026-10-07
---

# ADR-0028 — An automation can be triggered by a note, and can run a Claude step that only proposes

## Context

Automations (Phase 25) are notes in `.atlas/automations/`, run on a clock
(`daily`, `hourly`, `open`, `manual`) on the one Mac that holds them
(ADR-0025), with two actions (`archive`, `set`), a dry run, a log and undo.
The assistant needs them to react to a note — "a Meeting appeared" —
including one brought in by a sync pull, and to ask Claude to read it.

Today nothing can say which notes changed: the watcher hands TypeScript a
list of paths, and `app.tsx` drops it; a pull reports only `pulled: true`;
`refreshIndex` returns counts. Claude in Atlas (ADR-0021) runs Claude Code in
one fixed argument shape with its own tools off, reads through the API's
read routes, and turns every write into a proposal — but proposals live only
in a chat's memory, and the toolbox is built only inside the chat hook.

## Decision

**The index refresh reports what changed:** `refreshIndex` returns the
added, changed and removed notes with their type and a digest of their bytes.
That one change feed serves a typed edit, an API write, a watcher event and a
pull alike.

**A new trigger, "a note of a type is created or changed",** fires from that
feed, on the automations Mac only. In the rule's file it is written in words,
like every other `when`: `when: a meeting is created`, `… is changed`, or
`… is created or changed`. Its "where" is the rule's existing `which` query,
which must take that type's notes (`FROM meeting WHERE kind = standup`); the
rule acts only on the notes that set it off and that the query also matches.
_(Amended 2026-10-08, P29-01: this was drafted as an object,
`when: { kind: note, type, on, where }`. As built, it stays one line a person
can read and write by hand, as `daily at 03:00` is, and the where is not a
second query beside `which` that could disagree with it.)_

A note moved, renamed, archived or put back from the Archive is neither
created nor changed: the feed's removed and added pair one to one — by their
two paths for the Archive, whose stamp changes the bytes, and otherwise by
digest, the same name first. When a note leaves a path and a new one is made
there in the same sync, the feed reports that path `changed`; so a changed
note carries the digest it had (`before`, an addition to the P28-03 feed),
and one whose old bytes, or archived copy, turn up elsewhere is a new note.
A note in the Archive never sets a rule off. _(Amended 2026-10-11, #92:
in `Inbox/Meetings` a changed note that carries the import's stamp is never
the far end of a move — see the addendum.)_

**It is idempotent per note version:** the run log records `(rule, path,
digest)`, and a version already handled is never handled again — a restart,
a full re-index or a second pull does not re-run it. Notes changed by the
rule's own deterministic step are recorded under the new digest so they do
not re-trigger it. Notes an archive rewrote links in are not: their bytes
cannot say whether someone also edited them since the index looked, so they
are heard again, and at worst set the rule off once more. A path a note it
had handled left — deleted, moved, renamed, archived or replaced — is
recorded as gone, so a new note there is new to it. A run that changed
nothing is not logged and does not count toward the rule's cap of 20 runs an
hour; a rule at its cap, or failing, is paused, and runs on what it heard
meanwhile (up to 20 syncs' news) when the pause ends. The hour is counted on
the wall clock, in local time, as every automation's schedule is. Run now
takes the matching notes whose current version it has not handled.

**A new action, `claude`: a Claude step with a fixed shape.** The rule names
a prompt note (`.atlas/prompts/<name>.md`), the read tools it may use (a
subset of the chat's fixed read-only list) and an output kind with a schema
(`proposals`, or `note` — see below). It runs through the existing
`ModelProvider` and `runChatTurn` with the host's existing argument shape —
no new host command, no Claude Code tools, no MCP. Output that does not parse
against the schema is a failed run, logged, with nothing written.

**A Claude step never edits a note.** It can only:

- write **proposals** — notes of a built-in `proposal` type in
  `Inbox/Proposals/`, each with a kind (task, decision, follow-up, person,
  link, term, project), the change Accept would make, the source block it
  cites, and a confidence (high / medium / low). Proposals being notes means
  they sync, survive a restart and are queryable; the chat's in-memory
  proposals stay as they are.
- create **one new note** in a folder the rule declares (a morning brief, a
  weekly-review draft), never overwriting one.

**Deterministic steps are the only silent edits,** and only ones Atlas
declares as such (terminology correction is the first). Each records what it
changed on the note and is undoable like any automation run.

**What the Claude step is held to** _(Amended 2026-10-11, the review and
adversarial pass of P29-03, #16.)_

- **The notes are data in the system prompt, not the question.** Each is fenced
  as `<vault_data note=…>`, its text and path neutralized as the chat's open note
  is, cut to an equal share of a total budget. The Claude Code provider
  renders the conversation as a transcript that neutralizes every framing tag,
  so a fence in the question would have been taken down with the note's own
  and left its words bare; in the system prompt the fence is Atlas's alone. The
  question is one fixed line.
- **Text and links only.** An answer's note, proposal body, "why", title and
  properties may not load from elsewhere: no remote or by-reference picture,
  no HTML that loads or embeds (`img`, `iframe`, `script`, `link`, a `src`,
  `style` or `on…` attribute), no web address as a property's value. A picture
  whose address holds what the model read is a way out of the vault seen by no
  one; the whole answer is refused, with the reason. This does not cover what a
  person, a sync or an import wrote: the app's own CSP and a way to allow a
  remote picture are #101.
- **Strict and small.** An unknown key at either level refuses the answer; a
  proposal's payload carries `title`, `folder`, `properties`, `body` and
  nothing that would edit a note (`link`, `link_from`, `meeting`, a digest) —
  see "One writer, and the meeting a proposal came from" below for the one
  link a schema may add itself. Title, body
  and "why" have sizes, properties are few, flat and plain, and none is one
  Atlas keeps. What the model authored is cut before it reaches a log line or
  Activity.
- **Where it writes.** A rule's folder, a proposal's folder and the action a
  run is handed are all held to the proposals' refusals plus `Chats/`, the
  depth the vault is read to and the length a disk takes; the run checks the
  action again, and its prompt path, as the file that wrote it was checked.
- **A citation names a block the model was shown**, outside a code fence, in
  the text it was given before the cut. A meeting is cut between turns (a
  turn is a paragraph ending in its id), never inside one, and a run that cut
  a note says so in its log.
- **A half-written run is on record.** Every note is planned (name cut to what a
  disk takes, contents built) before the first is written. A write that then
  fails is logged as a failed run listing what it made, and the disk's error is
  raised. Each proposal carries a `proposal_id` (its rule, kind, title and cited
  block), so a run again makes none twice — whether the first is still open or
  was answered and archived. The key and the writer are P29-04's (#100): see
  the addendum below.
- **Asking costs, and the log says so.** A run that asked Claude counts toward the
  hourly cap whatever it came back with, a failure included. A Claude step on
  any trigger, not only a note's, skips a note version it has answered. A run
  over more than ten notes says it read the first ten and the rest wait for a
  run by hand, which takes them.

**Every run is in Activity:** trigger, note, digest, step, outcome, model,
duration, proposals made. Each rule has a run cap per hour.

### Addendum (2026-10-11, #92): note triggers and the meeting import

The meeting import (ADR-0027) writes `atlas_import_outcome` into every file
that lands in `Inbox/Meetings`, so a meeting's arrival and the import's stamp
reach the change feed close together, in one sync or two. A rule a meeting
set off could run on the unstamped version and then miss the stamped one,
run on a meeting the import went on to refuse, or — when two meetings had the
same bytes — take an old meeting the import stamped for the new one.

- **The feed says how the import settled each version.** A note's version
  carries its `atlas_import_outcome` when it has one, and a changed note the
  one it had before. The index already holds the stamp as a property; the
  refresh asks for it beside the manifest, so a relaunch knows it too.
- **Where meeting files land, a note is the import's until it lets it in.**
  A rule hears no note in `Inbox/Meetings` that is not stamped `imported`.
  The version that first carries `imported` is its arrival: a `created` rule
  runs once, on the version the import accepted, and a refused (`error`) or
  duplicate meeting never sets it off. The import's own stamp write is not a
  change to the note; an edit to a meeting it let in is. A note filed
  anywhere else is unchanged by this.
- **The general pairing stands, with one exception where meetings land.** A
  `changed` note whose old bytes, or archived copy, turn up elsewhere is
  still a new note made where the old one went. In `Inbox/Meetings` a
  `changed` note that carries a stamp now is never that: a new file lands
  unstamped, so a stamp is the import's own write (its first one changes the
  bytes a copy beside it may still have) or an edit of a meeting it let in.
  A path there that lost a stamp it had (`imported` to none) is a new file
  where the old one moved, and is paired as any other.
- **A meeting's arrival is heard once.** Only a `changed` note whose stamp
  went to `imported` from something else is an arrival; a file _added_
  already stamped (a sync's conflict copy, a meeting moved or restored) is
  not the import's work. The feed's baseline remembers, in memory, that a
  path's arrival was heard (`arrivalHeard`): it is set when the import lets a
  note in, kept if its stamp is lost (so the restored stamp is not a second
  arrival), set on a note that arrived as one end of a move (a meeting made
  elsewhere, then filed in), and cleared for a new file made where another
  went. A relaunch has only the stamps to go by.
- **The stamps are asked for narrowly, and not knowing is safe.** The refresh
  reads stamps only for paths under `Inbox/Meetings`, a page of 1,000 at a
  time (the host cuts a result at 5,000 rows). If they cannot be had — the
  query fails, or a result is still cut short — every note there is taken as
  already arrived: a sync, a rebuild included, goes on from its manifest and
  no meeting arrives twice; the cost is a missed edit of a let-in meeting.
- **Run now follows the feed.** A rule run by hand, or dry-run, plans over
  the same notes the feed would let it hear: in `Inbox/Meetings`, meetings
  stamped `imported` only.
- **One reader of a stamp.** The file's frontmatter and the index's rows are
  read the same way: a list by its first item, a name without the spaces
  round it, an empty list as no stamp, an unknown one as `imported`.
- News heard while the index opens is held and run once each, in the order
  it was heard (already so; now tested).

### Addendum (2026-10-11): one writer, and the meeting a proposal came from

_As built when the four post-processing changes were stacked: #97 (#92), #98
(P28-06), #100 (P29-04), then #99 (P29-03)._

- **One writer makes every proposal.** `planProposals` / `writeProposals`
  (`application/proposals`) take a `NewProposal` and are the only code that
  writes into `Inbox/Proposals/`; meeting linking and a rule's Claude step
  both go through them, and the step's own writer is gone. A checked proposal
  maps to a `NewProposal` field for field (`claudeNewProposal`). What the
  step's writer did that was general moved in, so linking has it too:
  everything is decided before the first write (names, numbered past the
  folder's and each other's, and contents); an id given twice in one batch is
  made once; the folder's own files are read for ids the index has not caught
  up with; and a long name leaves room for the number a taken name gets.
  What differs is what each does with a write that fails: linking writes the
  rest and says which were left; a Claude step stops, fails the run, logs what
  it had made, and raises the disk's error.
- **The limits stay the step's.** Sizes, flat plain properties, no remote
  resource, where it may write and the citation check are rules about a
  model's answer, and are applied before the writer is reached. Linking's
  proposals are built by Atlas from a meeting the import validated.
- **No answer names a note to edit.** P29-04 gave a payload `link_from` and
  `meeting` (provider, id), which Accept writes into a note already there. A
  draft's payload with either — or a link's `note`, `link`, `digest` — is
  refused, as is the kind `link`.
- **A schema may link a proposal back to its source meeting** — the extension
  point for P29-05 (#18). A schema declares `meetingRelations` (relations of a
  meeting, fixed in code and checked when it is registered: not a key Atlas
  keeps), and a draft says `joinsMeeting: '<one of them>'`. The shared check
  then adds `link_from` itself: the note is the one the draft **cites** — a
  note the run read — the property is the schema's, and the meeting's identity
  is what the **run** read from that note's own frontmatter (`AnsweredNote
.meeting`), and only for a meeting stamped `imported`. A draft naming a
  relation its schema does not list, or citing a note that is not such a
  meeting, is refused. Nothing in the answer can choose the note, the
  property or the identity. Accept then does what it does for a person
  proposed from a meeting: makes the note (a task also records its `source`
  block), finds the meeting by its identity wherever it has been filed, and
  adds the link — refusing a meeting that is archived, or another meeting now
  at the old path. The meeting type must have the relation, or Accept refuses
  the link; `proposals`, the general schema, declares none.
- **A Claude step on "a meeting is created" needs nothing new.** The import
  links a meeting, then corrects and stamps it in one write (ADR-0027), and a
  note where meetings land is heard only from the version that first carries
  `imported` (the addendum above). So the step is asked once, about the
  linked and corrected meeting; a duplicate or refused file never asks; the
  import's writes are not a `changed` to any rule; and the step's proposals
  are not meetings, are never handed to a Claude step, and are made once by
  their ids even when the rule's log is lost.
- **The log says when a note was cut.** A note longer than its share (20,000
  characters, or an equal share of 120,000 across the run's notes) is shown
  from its start. The run's `claude` line is followed by
  `- cut "<path>": read <shown> of <total> characters` for each, the summary
  says so, and the log API carries it as `claude.cut`. Chunking a long
  transcript is left to P29-05, which now has the fact to decide on.

### Addendum (2026-10-11): after the adversarial pass on the stack

_As built on #99 after an adversarial pass over the four stacked changes
(`claude-step.stack.adversarial.test.ts`, `claude-step.stack.test.ts`,
`source-meeting.adversarial.test.ts`, `use-automations.held-news.adversarial
.test.tsx`, `use-automations.catch-up.test.tsx`). The import's side of the same
pass is in ADR-0027._

- **"Not asked twice for the same words" holds wherever the note goes.** A
  rule's history is by path, and a path a note left has none — right for a
  rule that sets or archives (a new note there is new), wrong for a Claude
  step: a meeting filed out of the Inbox, not a byte changed, was asked about
  again by Run now. The digest of a version a run **asked Claude about** is
  now handled at whatever path those bytes are (`handledVersions`); the log
  needed no new line, since a Claude run's entry already holds the digests. A
  failed step answered nothing. A meeting edited after it was answered is
  another version, as it is in place: Run now asks about it. Keying by the
  meeting's provider and id as well was considered and left out — it would
  make a filed, edited meeting behave differently from one edited where it
  landed.
- **A proposal's id comes from what it cites, not how the citation was
  written.** The id was a hash of the rule, kind, title and the `source` text,
  so `[[Standup#^t1]]` and `[[Inbox/Meetings/Standup#^t1]]`, or the same turn
  once the meeting was renamed, were two proposals. A checked proposal now
  carries `cites` — the note the link resolved to among those the run read,
  that note's meeting identity when the import vouches for it, and the block
  id — and the id is the rule, kind, normalised title and that: a let-in
  meeting by provider and id (filing and renaming do not change it), any
  other note by its path (renaming such a note does change it). `source`
  still shows the link as the model wrote it. **Every id a Claude step made
  before this changes**; nothing was released, so nothing is migrated — an
  open proposal from an earlier build could be made once more.
- **A title two notes share is not a citation.** A link by bare title that
  matches more than one of the notes the run read is refused, with words
  telling the model to cite by path (`[[Folder/Note#^id]]`), which the step's
  instructions now also say. It was first-wins by the order the notes were
  read in, which for `joinsMeeting` chose the meeting Accept writes to. A
  target that is a note's whole path names that note alone.
- **A meeting is cut by turns whatever its line endings.** The blank line
  between turns is now found in a CRLF file too; before, such a meeting past
  the limit was shown as nothing at all.
- **One reader of "is a meeting".** `isMeetingType` (a list, any case, as the
  index counts it) is what linking, correcting a meeting's terms and a Claude
  step's `AnsweredNote.meeting` all read. The identity keeps the provider as
  written and trims the id, as `sameMeetingIdentity` and the holders query
  compare them — a trimmed provider would name a meeting Accept cannot find.
- **A re-ask that finds everything made says so.** The run's `claude` record
  carries `alreadyMade` (an `- already made` line with the count, in the log) and its summary
  reads "Nothing new to propose (2 already made)." instead of "Claude proposed
  nothing."
- **News let go is said.** A rule held back keeps 20 syncs' news, and news
  heard before the rules can run is kept to 20 as well; past that the oldest
  went silently. Each one let go is now counted and, within the minute, said
  once per rule: in Activity (a warning) and as a `letGo` entry in the rule's
  log, with how many and that Run now takes the notes they named. It is not a
  run: it counts toward no cap and no schedule. News dropped before any rule
  could hear it is counted against every enabled note-triggered rule, since
  it may have been any of theirs.

#### Catching up when Atlas opens

An arrival is heard in memory. Quit between the import's stamp reaching the
feed and the rule's run — or while the rule was held back, or mid-run — and
on relaunch the feed has nothing to say: the meeting is already `imported` in
the index, so `created` is never heard, and the meeting waited for a run by
hand for ever.

- **What is caught up with.** Once per vault opened, on the Mac that runs its
  automations, with the index ready: for each enabled rule whose trigger
  includes `created`, the notes in `Inbox/Meetings` that are of the rule's
  type, stamped `imported`, **last written after the rule's own file was**,
  and of which the rule's log holds nothing — no version at that path, and
  not those words (`missedArrivals`, domain; `runOnMissedArrivals`,
  application). They are run on as the feed's news would have been: the
  rule's query among them, the per-run cap (10 for a Claude step; the log
  says when it stopped short, and the next opening takes the rest), and the
  hourly cap — held by it, the look is kept in the rule's queue like news and
  runs when the pause ends.
- **Why "since the rule's file was last written".** Nothing in a meeting says
  when it was let in, and a `created` rule must not act on what was there
  before it existed or was turned on. The import's stamp is the last write to
  a meeting until someone edits it, and turning a rule on or saving it writes
  its file; both times come from the same disk, so no clock is converted. It
  is read from the index's manifest and one read of the rule's file.
- **What it gets wrong, knowingly.** A meeting let in, then the rule edited,
  then Atlas quit before the run: left out (Run now takes it). An old meeting
  still in the Inbox, never handled, edited after the rule was saved: taken
  as an arrival once. A pull that rewrites the rule's file moves its time
  forward. A rule that only sets a property and found nothing to change logs
  nothing, so it looks again each opening, and again changes nothing.
- **A fresh clone or a restore.** The rule's file is written when the vault
  is cloned or restored, which can be before `Inbox/Meetings` is: every
  meeting there then looks written after the rule, and the log of a clone has
  no entries to say it was handled (the log is a file too, but a restore from
  an older copy may bring an older one). Those meetings count as arrivals the
  first time Atlas opens. It is bounded by the per-run cap (10 for a Claude
  step, the rest taken by later openings — each of which is then in the log —
  or ignored by Run now), by the hourly cap, and by the ledger's floor when
  its log is intact; it is not prevented.
- **Only the meeting case.** Elsewhere a note's arrival is the feed's `added`,
  and what was added while Atlas was closed is reported by the first sync
  after opening (the index's manifest is the baseline), so nothing is lost
  across a relaunch except what was already heard and held — which Run now
  takes. A general catch-up ("notes matching the rule, appeared since its
  last run, with no handled version") would need an arrival time the files
  do not hold; it is left out.

#### The handled ledger

The rule's log keeps its last 100 entries, so it cannot also be what a rule
remembers having handled: a meeting whose run aged out would be asked about
again at every opening, and sixty "news let go" notices were enough to push
sixty runs out. What a rule has handled lives in a **ledger**, a section at
the top of the same log note, written in the same write as the entry that
changed it and never counted among the entries a log drops:

```markdown
## Handled so far

<!-- atlas:handled-ledger v1 -->

Atlas keeps this list so the rule remembers what it has handled after old entries leave this log. Leave it as it is.

- through `"2026-10-08T09:00:00"` `"5e6f7a8b"`
- records `2`
- vouches from `"2026-07-01T00:00:00.000Z"`
- handled `"Inbox/Meetings/Standup.md"` `"2026-10-08T16:00:00.000Z"`: `["1a2b3c4d"]`
- answered `"Inbox/Meetings/Standup.md"` `"2026-10-08T16:00:00.000Z"`: `["1a2b3c4d","meeting:larkspur:m-1042:body:9f8e"]`
```

- **How it is found.** One locator serves the reader and the writer: a
  section whose `## Handled so far` heading starts its line and whose very
  next line is the marker `<!-- atlas:handled-ledger v1 -->`. The marker is
  what makes it Atlas's; a section a person titled the same is theirs, is
  never read or replaced, and stays in the file beside the ledger. The `v1`
  names the format: a marker of another version is a ledger this Atlas
  cannot read, which counts as damaged (below) and is replaced by a `v1`
  one. Two ledger sections are merged into one (and also count as damaged).
- **`handled` lines** are the versions handled (or left by the rule's own
  write) at a path, newest last, **at most 5 per note**, with when the path
  was last recorded. A path the log says went, or that the run archived, is
  removed, exactly as the entries' reading did.
- **`answered` lines** are the words a Claude step was asked about: the path it
  was answered at, when, and **a list of keys** — the whole-file digest
  first, then any key the rule's schema supplies (at most 8, none over 256
  characters). A log entry's version line carries those as
  `… at `"digest"`also`["meeting:larkspur:m-1042:body:9f8e"]``; the ledger
  carries them forward. A version is answered if any of its keys is one an
  answered line holds, wherever the note is now, whatever else changed.
  **A schema key must be unique to the thing answered**: it MUST include the
  note's identity, as `meeting:<provider>:<external_id>:body:<digest>` does,
  and never be a bare body digest, which two notes can share. Atlas enforces
  only the minimal shape (non-empty, a `:` with something on each side) and
  drops a key without it, both when it records and when it matches; the
  producer of the meeting key lands with the meeting-items schema (#102).
  Catch-up (`missedArrivals`) honours keys as the feed's path does and hands
  them on with the versions it returns.
- **Times are real instants.** Every time the ledger holds — a record's, and
  the `vouches from` floor — is UTC, from the clock the use-case was handed
  (`appendToRuleLog` takes `now`), and is compared with a file's modified
  time, which is an instant too. An entry's heading is the person's wall
  clock (`2026-10-08 09:00:12`), kept for reading; nothing compared with a
  file's time is derived from it. (A wall-clock read as UTC is off by the
  zone's offset, which hid a meeting never asked east of UTC, and asked one
  again west of it.) An entry from before this, with no zone to read it by,
  is taken at the earliest instant it could be (14 hours before it read as
  UTC), so a floor made from it is never later than the truth.
- **Pruned by age, count and bytes**, oldest first: records older than 90
  days by the clock's `now`, then past 2000, then past 96 KB for the whole
  section (well under the log's 256 KB, whose budget counts it). Pruning
  sets `vouches from` to the newest time it forgot, never later than `now`.
  Catch-up (`missedArrivals`) never reaches behind it: it considers a meeting
  only if written after both the rule's file and that floor, since a meeting
  last written before what the ledger forgot cannot be vouched for. Age is
  measured only against the injected clock: an entry that claims a time long
  after it (a clock that jumped) cannot age the ledger or floor catch-up.
- **What it has folded in: `through`.** The line names the last log entry the
  ledger had absorbed (its heading time and a digest of its text). An Atlas
  that does not know the ledger — a second Mac not yet updated, a rollback —
  still appends runs to the log. On read and on append, the entries after
  `through` are laid over the ledger, oldest first, so they are never
  forgotten. If the named entry is gone (that Atlas dropped it), the entries
  written after its time are laid over. Entries at or before `through` are
  not replayed, so what the ledger let go or pruned stays gone.
- **A damaged ledger.** `records` says how many `handled` and `answered`
  lines were written, so a line lost is told from one never there. A line
  that does not read, a count that does not match, a missing `through`, two
  ledgers or an unknown version make the ledger _damaged_: it is not
  trusted to have folded anything in, so every entry still in the log is laid
  over it (recovering what the log still says), and it vouches for nothing
  until it is written again — a reader treats the floor as ahead of every
  note, so no catch-up runs. The next write mends it: the floor is set to
  that moment (`vouches from` now), the section is rewritten clean, and
  Activity says once that the list was damaged and rebuilt. Meetings written
  before then that the log does not show are not asked about; a run by hand
  takes them.
- **A log without a ledger** (written before this) behaves as it did: the
  ledger is built from its entries the first time it is added to, and read
  from them until then. If it already held 100 entries it may have dropped
  some, so it vouches only from its oldest. A ledger a person deleted is
  built again from whatever entries remain.
- **Let-go notices fold**: a `letGo` entry written right after another joins
  it, the counts summed, so a burst is one entry and costs the log no run.
- **A different note with the same bytes is not answered.** Words answered at
  a path are the note's alone while that path still holds them: another note
  (two tasks from one template) is asked about. Once the answered path holds
  other bytes or none — the note was filed, renamed or edited — those words
  at any path are taken as answered. A note carrying one of the answered
  version's schema keys (the same meeting identity) is the same note wherever
  it is. The path's current digest is read from the index when a run decides,
  and only when a version is handled but not at its own path.

#### Known behaviour, left as designed

- **One bad item refuses the whole `proposals` answer.** The general schema is
  all or nothing: a single item that cites nothing real, or carries a key it
  was not asked for, fails the run with nothing written.
- **Two rules that propose the same item each make their own proposal.** An id
  includes its rule, so two rules reading one meeting can both propose "Send
  Mara the file"; they are answered separately.

### Addendum (2026-10-11, P29-05, #18): meeting extraction

_As built on the stack above: the `meeting-items` output._

- **A second output, through the extension point.** `output: meeting-items`
  asks for `{ "items": [ … ] }`, each `{ kind: task | waiting | decision |
follow-up, title, owner, due?, source_block, confidence }`. The model says
  what and who in words; what a proposal then does is decided in the domain
  (`automations/meeting-items.ts`, `meeting-item-owner.ts`).
- **Mine, or waiting for.** The owner an item names is read against the
  meeting's attendees, the vault's people and the profile (`vault-owner.ts`,
  `matchAttendees` — the linking code's own). `You`, the profile's name, or a
  name or address the owner's Person note holds: a task at `inbox`. Anyone
  else: a task at `waiting` with `waiting_on` a link to their Person note —
  or, when the vault has none, or several it could be, their name as text,
  which the card says. A `decision` is a note of the built-in Decision type,
  naming its meeting. A `follow-up` is an `inbox` task tagged `follow-up`,
  whoever was named. The model's `task` / `waiting` is a hint; the owner
  decides.
- **Attribution that rests on a guess is low confidence, whatever the model
  claimed.** Nobody named (blank, or what a provider calls a speaker it could
  not name): an Inbox task with an empty `waiting_on` to fill in on the card's
  Edit. A cited turn whose speaker is unnamed: whoever was named is a guess.
  Called a waiting-for but owned by the owner: the two disagree. Each says so
  in the proposal's body, which the Inbox card now shows under its headline
  (`reason` in `GET /v1/proposals`); a low-confidence card is marked down its
  edge.
- **Every item cites one transcript turn, and a missing one drops the item,
  not the answer.** `source_block` is a turn's id (`t0004`); Atlas writes the
  link. Only a turn of the Transcript the model was shown counts — not the
  summary, not the provider's next steps, not a turn in another part. This is
  the one exception to "one bad item refuses the answer", and a schema has to
  ask for it (`ProposalSchema.dropped`): the item is left out, the rest are
  kept, and the run's log names each (`- dropped "<title>": <why>`,
  `claude.dropped` in the log API, and the summary Activity repeats). Anything
  else wrong with an item still refuses the whole answer.
- **One meeting per ask.** Which meeting an accepted task joins follows from
  the turn it cites, so an answer about two meetings could file one's task
  under the other, and two meetings of one title could not be told apart. A
  `meeting-items` run asks about each note alone, and the schema leaves out
  every item of an answer checked against more than one note.
- **A long meeting is read in parts, not cut.** Chosen over "say only the
  start was read": at 20,000 characters a note, most real meetings would have
  lost most of their transcript. Each part is the meeting's head (frontmatter
  and every section before the transcript, so the hints ride along) and as
  many whole turns as fit in 20,000 characters, with a line saying which part
  it is; parts do not overlap. A run makes at most ten asks
  (`CLAUDE_ASKS_PER_RUN`, the number of notes one run may read): every note
  gets one, and the rest go to long meetings in order. Past that the rest of a
  meeting is not read, and the log says so with the existing `- cut` line and
  summary. The log says how many times it asked (`- asked 3 times`,
  `claude.asks`). Every answer is read before anything is written: one that
  does not read fails the run with nothing made, naming the ask. Superseded
  below: the hourly cap counts asks. Not done: no
  overlap between parts, so a commitment made across a part's edge may be
  missed; and a hint whose turn is in another part can only be dropped there.
- **What the model is told beside the meeting is data.** The schema gives
  (`dataFor`) who the vault's owner and the attendees are, the provider's own
  next steps as hints, and the Terms vocabulary's right spellings; the prompt
  builder fences each as `<vault_data about=…>`, neutralised as the notes are.
  The run reads the people, the terms and the profile's name itself
  (`readsVault`) — never from the answer.
- **The prompt ships with the rule.** `.atlas/prompts/meeting-extraction.md`
  is a prompt Atlas has the text of (`built-in-prompts.ts`). It is written
  when a rule that names it is saved — the Automations page offers the rule
  ready-made, "Pull actions and decisions out of a new meeting" — and only
  where there is no note: nothing is written into a vault without that yes,
  and a prompt that is there is the person's.
- **The Meeting type gains `tasks` and `decisions`** (relations, many), which
  `joinsMeeting` links through. A vault's Meeting type is offered them beside
  the import's keys; without them Accept is refused, saying the meeting has no
  such relation, and nothing is written. A Decision also carries `meeting`, its own link forward.
- **A meeting is one however its `type:` is written.** The step and linking
  read it with one reader (`isMeetingType`): a list, or another case.

#### Review pass on meeting extraction (PR #102)

_As built after review and an adversarial pass. Where it differs from the
bullets above, this wins._

- **Who owns an item is read, not guessed.** `You` (with a full stop, or a gloss
  such as `(Mara Quill)`), the profile name in its spellings (`Last, First`,
  case), its first name when no other attendee has it, and any address on the
  owner's Person note (`a@b`, `Name <a@b>`) are the owner. `We`/`us` is the
  owner's, at low confidence. `Everyone`, `The team`, `All`, `Not sure`, `TBD`
  are nobody. `[[People/X|Y]]` reads as X. An address matches an attendee or a
  Person. Two owners (`You and Tobias`) are not split into two items: it is the
  owner's one task, low, naming the other in the reason (no owner among them: a
  task with an empty `waiting_on`, saying who it could be). A first name two
  attendees share, or a name several Person notes could be, is ambiguous: an
  Inbox task with an empty `waiting_on`, low, and the card lists who it could be
  (never "no Person note yet"). A group attendee or address is never a
  waiting-for owner. A name in no attendee list and no Person note is low.
- **Who spoke the turn caps the card.** A cited turn with no named speaker makes
  the owner a guess (low) and a decision or follow-up low. A turn spoken by a
  named person who is neither the task's owner nor the vault's owner makes it
  medium at most: they may be asking you, or speaking of a third person. A turn
  the owner spoke, or the vault's owner handing a task out, raises no doubt. The
  rule is deliberately simple; "someone addressing the owner" is not detected.
- **An item's own fault is the item's, not the answer's.** A kind, owner,
  confidence, title or `source_block` that does not read, an owner over 120
  characters, an item that is no object: the item is dropped and logged
  (`- dropped`). A `due` that is no date, an impossible day, or more than five
  years from the meeting's date (a year 2000–2100 when the meeting has none):
  the item is kept with `due` removed and one step less confidence, and logged
  (`- adjusted`, `claude.adjusted`). Unparseable JSON, an unknown key and more
  than 25 items in one answer still refuse the whole answer.
- **At most 25 proposals a run**, across parts, in transcript order (the answer's
  items are put in the order of the turns they cite); the rest are left out and
  the log says how many (a `dropped` entry).
- **The hourly cap counts asks.** A run spends one for each time the model was
  asked (`claude.asks`, now recorded from the first ask), and nothing when it
  never asked (a prompt that could not be read, a provider not ready, a prompt
  note over 20,000 characters, a system prompt over 450,000 bytes). A run may
  take the rule past the cap by its own asks (at most ten); the next is held.
- **One deadline for the run: ten minutes**, for all its asks (not five minutes
  each), since a long meeting asks up to ten times.
- **A meeting with no transcript turn is not asked about**; its note is in the
  entry's `left` with why, and it is handled like any asked note. A meeting the
  import did not let in is read, and its proposals are made without
  `link_from`, saying so in the reason (the run does not fail).
- **Chunking.** A part's head is fence-safe and bounded to half the room: if the
  Summary, Notes and next steps exceed it the Notes are cut at a line, any open
  code fence is closed, and a line says so; the Transcript heading is found by
  the same section reader as the import's contract (`splitMeetingSections`), so
  a `## Transcript` inside a fence is no heading. Each later part opens with the
  last two turns of the part before, quoted (`>`) with their ids removed, so
  they give context and cannot be cited. The data block stays after the notes (a deliberate
  order, tested: the meeting is read first); putting it first for caching was
  considered and left, since it would move the vault's text nearer the question.
- **A proposal is known by the meeting, not by the rule.** The id of a
  `meeting-items` proposal is the meeting (provider and id), the turn, the kind,
  the normalised title and the normalised owner (`self`, a person's name, `?`
  for an ambiguous name, empty for nobody): two rules, or a rerun, make each
  once, and two owners of one title on one turn are two proposals. Other
  schemas keep the rule in the id.
- **Accept makes its own record.** "A note is already there, so link it" now
  applies only to a person. A task, follow-up or decision takes the next free
  name (`Send the notes 2`) and links that note; it never links an existing
  note in its place, and Accept never answers "accepted" having written nothing.
  A task waiting on a Person note that has since been renamed or deleted is
  **refused** (a `conflict`), not accepted with the name as text: a link to
  nothing would read as waiting on nobody, and Edit fixes it in one step.
- **Undo is all or nothing.** Every write of the accept is checked before any is
  taken back; if the meeting changed since (a second accept wrote its `tasks`),
  the undo is refused with nothing changed. Otherwise the meeting's link goes
  first, then the task.
- **Accepting does not make a meeting new.** A schema may name what a note is
  answered by besides its whole-file digest (`ProposalSchema.handledKeyOf`);
  `meeting-items` names its **body** digest, as `meeting:<provider>:<external_id>:body:<digest>` — keys match across paths, so a bare digest would make two meetings with the same words one; a meeting the import did not vouch for has none. The key rides on the version as one
  of the ledger's extra keys (`withHandledKeys`: when planning a run, hearing
  the feed and catching up at open; no other persistence), so Accept writing
  the meeting's `tasks`/`decisions` — frontmatter only — is not new words and
  Run now after an accept asks nothing. An edit to the words is new.
- **The run warns, once**, when the Meeting type lacks the `tasks` or `decisions`
  relation (`claude.warnings`, a `- warned` log line, Activity): the proposals
  are made, and Accept refuses them until the type has the relations.
- **Not done:** no overlap beyond the two quoted turns; "addressing the owner"
  is not detected; a compound owner among others (`Tobias and Lena`) is not
  split into two tasks.

### Addendum (2026-10-14, #162): an older Meeting type gains the relations on opening

Amends "a vault's Meeting type is offered them" above: opening a vault now
adds `tasks` and `decisions`, and the rest of what Atlas ships on its own
types, to a type file that lacks them. The decision, its scope and its limits
are ADR-0016's amendment of 2026-10-14 (#162).

## Consequences

- A Mac that is not the automations Mac never runs Claude on a meeting; the
  meeting waits until that Mac is awake and has pulled.
- Claude runs unattended on vault text, which is untrusted (ADR-0021). The
  defence stays structural: the step cannot edit, only propose or create.
- `Inbox/Proposals/` grows; accepted and rejected proposals are archived by
  the existing Archive, so the folder holds only open ones.

## Addendum, 2026-10-14: one declared step may write (ADR-0036, ADR-0035)

Four statements above change. ADR-0035 and ADR-0036 are proposed. This amendment takes effect when ADR-0035 and ADR-0036 are accepted, and until then this record's
text stands.

- **"A Claude step never edits a note."** One declared exception: ADR-0036
  lets the "After a meeting" rule's step write a **marked, bounded,
  digest-guarded summary block** at the top of a meeting, and make a **task
  for the owner's own action item** at medium confidence or above and with no
  domain cap, without a proposal. Both are declared on the rule, undone by
  Undo last run, and refused over the person's edits. Backfilled meetings and
  everything else a step produces stay proposals.
- **The handled ledger's extra key** for a meeting (above) is the **body**
  digest. It becomes the **transcript section's** digest, because the
  summary block and edits to `## Summary` and `## Notes` change the body's
  digest. The ledger entry also holds the step's stored answer, reused by
  every retry.
- **The caps.** That step has its own ask budget (10 asks per run, reduce
  included) and one hourly allowance of 30 asks shared by every rule that
  declares it, apart from each rule's 20
  runs an hour, and defaults to a cheaper model with `model:` to override.
- **"A Mac that is not the automations Mac never runs Claude on a meeting;
  the meeting waits until that Mac is awake and has pulled"** stays true.
  ADR-0035 adds a banner on a Mac that is not named and a one-click "Process
  here" that names it; the catch-up (`missedArrivals`) is once per vault
  opened and is not reset today; ADR-0035 resets it when `scheduled` goes
  false to true (the button or Settings → Sync), instead of waiting for the
  next open. The step also runs on every Mac, the named one included, only
  after a pull completed since launch or wake and only if that Mac is still
  named after it.

## Amendment, 2026-10-15: a rule follows a note it handled that moved (ADR-0038, #214)

Since #214, meetings land in `Meetings/<YYYY>/<MM>` as well as `Inbox/Meetings`,
and the offered tidy moves let-in meetings from one to the other. A move ended
a note's history (`went`), so the catch-up took a tidied meeting for an arrival
the rule never ran on and ran a `set` rule on it again.

- A run that hears a note it handled move — paired by the feed as a move,
  rename, filing, archive or unarchive — writes `- moved `"from"`to`"to"`at`"digest"`` beside `went`: the `handled` record at the old path goes to the
  new one, with the version it moved as. An entry with only `went` and `moved`
  is the rule's memory, not a run.
- The catch-up also passes over a meeting whose file name the rule handled at
  a path no note holds now: a move it never heard (news let go, a move while
  it was held). Taking a new meeting of that name for it skips a catch-up; it
  never runs a rule twice.

## Amendment, 2026-10-23: a weekly schedule, one note a period, and cited items (#40)

The Friday review draft (P32-09) needed three things the rules did not have:
a schedule that runs on one day of the week, a note output that a second run
cannot duplicate, and a way to hand a step data DFAI reads itself. Before
this, a daily note-writing rule run twice in a day made `Morning brief 2.md`,
which broke "never overwriting one" in spirit: two drafts of one brief.

- **A weekly schedule.** `when: fridays at 15:00` (any weekday; the file also
  reads `friday at 15:00`, `every friday at 15:00`, `weekly on fri at 15:00`,
  and writes the first form). Like `daily at`, it is a time on the person's
  wall clock, and the next run is counted in whole days of that clock, so a
  clock change in between moves neither: 15:00 stays 15:00 across the night
  the clocks go back. A time that never shows on the night they go forward
  (02:30) is due the first moment the clock reads past it; one that shows
  twice when they go back runs once, because the run is the mark the next is
  counted from — and a mark up to an hour ahead of the wall clock still
  counts, since the log keeps wall-clock time and the second pass through the
  hour reads as earlier than the first run (a mark further ahead is a clock
  that ran fast and is ignored, as before). `thurs` reads as Thursday, as
  `tues` and `weds` do. A Friday missed while DFAI was closed is caught up once, on
  opening.
- **One note a period.** A Claude step whose output is a note, on a daily or
  weekly clock, writes one note for each day (a daily rule) or ISO week,
  Monday first (a weekly one), however it runs. A period is the week or day,
  not the slot string, so moving the rule from 15:00 to 16:00 the same Friday
  opens no second period. A scheduled run writes for the latest time its
  schedule fell due at or before the run (a Monday catch-up writes for the
  Friday before); **Run now writes for the current calendar week** (today, for
  a daily rule), whether or not that week's time has come. Which periods have
  their note is read from two records that each work alone, never from the
  folder's file names (which a person renames):
  - the rule's log: the run that made the note writes
    `` - period `"2026-10-23T15:00:00"` ``; and
  - the note itself: it is written with `atlas_period: "2026-10-23T15:00:00"`
    in its frontmatter (and `atlas_period_item` for an item), so a crash or a
    full disk between the note and its log line, a log that outgrew its cap,
    and a note synced in from the other Mac all still say the period is made.
    The log's cap (100 entries) never drops the one entry that last made a
    period's note. The note also carries the id of the rule that made it,
    `atlas_period_rule: "Friday review"`, for two rules can write into one
    folder: only a note naming this rule uses up this rule's period. A note
    naming no rule (a draft from before the stamp, a note a person copied)
    counts only when this rule's log says it made that note.
    A later run in the period asks Claude nothing and is logged as having found
    the note made, so its schedule still counts on from it. A period whose run
    failed made nothing, so the next run in it writes the note. A period ahead of
    the clock (a Mac whose clock ran a month fast) is never counted as made.
    **Deleted or undone drafts:** a scheduled run never writes a period that is
    recorded, even if its note was deleted or its run undone; Run now writes a
    fresh note when the period's note is no longer on disk (an undone run does
    not count as having made it). The key can carry an item —
    `` - period `"…"` for `"Meetings/2026-10-23 Standup.md"` `` — so a rule that
    writes one note per item of a period (#39, a brief per meeting of the day)
    uses the same record (`outputPeriod`, `currentPeriod`, `periodNoteMade`,
    `periodRecorded`). Hourly, on-open, by-hand-only and note-triggered rules have
    no periods and behave as before. A dry run says what Run now would do: "Would
    write its note", or that the period's note is made already.
- **Two Macs.** Scheduled Claude runs are already gated to the named Mac
  (`gatedByFreshPull`, ADR-0035), so only one of them writes the draft; the
  note's own `atlas_period` is what lets the other Mac, once the note syncs in,
  count the week as made. The period is read again at the last gate before
  the write, after Claude has answered: a note for it that synced in while
  Claude was asked means nothing is written, and the run is logged as one
  that found the note made.
- **Each period asks afresh — when something to ask about changed.** A
  note-a-period step is not held to "never asked again about a version it has
  answered": this week's draft is about the week as it is. But a scheduled run
  of a step that reads notes through a fixed query (a morning brief of the
  waiting tasks) and is handed no data asks nothing when none of the matched
  notes changed since its last note: it records the matched versions and logs
  a run that did nothing. A step handed data always asks once per period, for
  the data is what changes; Run now always writes the period's note when it is
  missing.
- **Data beside the notes.** `data: weekly-review` hands the step the weekly
  review (P30-07) as `<vault_data about=…>` blocks — the tasks finished and
  meetings held in the 7 days from the slot before the period's to its own
  (exactly one week: no eighth day, no overlap with the next review; the days
  are counted on the calendar, so a clock change moves none), a task counted
  as finished on the day its `completed` says, and by its last change only when
  it says none, waiting-fors untouched for more than 7
  days, overdue tasks, active projects with no next action, someday items
  untouched for 30 days (at most 50 each), and the Inbox's count — each item
  with its note's path. It goes with `output: note` only, and a step with data
  may leave `which:` out: it reads its data alone, and runs with no notes. This
  is a data input rather than a read tool because it is what the step is
  about, not something it might look up, and a tool would be a new API route.
- **Every item cites a note it was given.** In the note such a step writes,
  each list item — in a block quote too — must link, by path, one of the notes
  in its data or among the notes it read. An item that links none — no link, a
  link by bare title, a link to a note it was not given, a link in code — is
  left out with its indented lines and children and the rest kept, named in the
  log as `- dropped …` (`claude.dropped`), as a meeting's uncited action item
  is. In an item that is kept, a link to a note the run was not given is
  written as the words it showed and named in the log as `- adjusted …`
  (`claude.adjusted`). A note whose every item was left out, or that has no
  list item at all when the run was given notes to cite, is refused and
  nothing is written. A run given nothing to cite (a quiet week) is never
  refused, but it has nothing an item could cite, so every item is left out
  (named in the log as dropped) and the draft is its frame plus the line
  "Nothing to cite this week.", which DFAI adds and the model does not. Headings and
  sentences (the Inbox's count) are the draft's frame, not claims, and are not
  held to it, but their links are written as an item's are: a link to a note
  the run was not given becomes plain text and a source id its title. The
  check is the domain's (`keepCitedItems`), whatever the prompt says.
  A period's note is the rule's by the `id:` stamped in it (compared by case and
  Unicode form, as ids name files). A legacy rule with no `id:` written, renamed
  by hand, has the new name as its id, so one draft made under the old name does
  not count for it and the week can get one duplicate draft.
  A note whose name no link can hold (`#`, `|`, `[`, `]`, `^`) is handed under a
  source id, `[[src:3]]`; the id is accepted as a citation and written in the
  draft as the note's title in plain text, so no link in the draft fails to
  resolve, and the written draft never holds `[[src:`, in an item, a sentence
  or a heading (only in code, which is shown as written). Values from notes (a
  task's waiting-on, a title) are flattened to one line with every run of
  brackets broken (`[[[` too), so vault text cannot forge an item or a link.
- **The editor** clears a step's data when its Writes is switched away from a
  note, since the control that sets it goes with the note output.
- **The Friday review preset** puts these together: `fridays at 15:00`, its
  prompt `.atlas/prompts/friday-review.md` (written once, never over yours),
  `output: note` into `Reviews/`, `data: weekly-review`, no query.

## Amendment, 2026-10-29: a Claude step that cannot reach Claude is retried (#182, PR #637)

Applies to every rule a note sets off whose step is `claude`, not only the
declared meeting step.

- **Claude out of reach is a failure the runner hears.** The provider is not
  ready (Claude Code not installed, logged out, no key), or it says so
  part-way through an ask. The run is logged as `failed` with the fix-it
  line, as before. It is then **raised** (`ClaudeUnavailableError`), so the
  runner pauses the rule, holds the news it heard (up to 20 syncs' worth) and
  tries again when the pause ends. The wait doubles from a minute, as for any
  failing rule, but is **capped at 15 minutes** (`unavailableBackoffMinutes`)
  rather than six hours. The pause records how Claude was found out of
  reach. If the **status** said not ready, the runner asks the status again
  at each minute's tick. That is local and asks Claude nothing. Once it says
  ready, the pause goes and the held news runs at once. If the status said
  ready and a real **ask** was refused (a revoked key, an expired token), the
  status cannot see that end. The pause then keeps its backoff and its
  failure count, so Claude is asked at most once per backoff and the
  warning is said once (amended after the PR #637 attack).
- **A bad answer or a timeout settles.** An answer that does not parse, a
  deadline missed or an API failure (`ModelProviderError` `failed`) is logged
  as `failed` and settles, with no pause and no news held. Asking again would
  spend asks on the same words.
- **Run now never raises.** Run by hand, the step settles with its `failed`
  entry. If the rule is already paused because Claude is out of reach, that
  failure leaves the pause and its warning as they are, so the line does not
  flicker and Activity does not say it again.
- **The pause lives in memory.** After a restart, the rule is caught up on
  opening (missed arrivals, for a rule set off by `created`). If Claude is
  still out of reach, that run fails and the pause comes back. A rule that is
  not set off by `created` has no catch-up, so its pause, and the named
  Mac's line, return only with its next run. A Mac that stops being the named
  one drops such pauses.
