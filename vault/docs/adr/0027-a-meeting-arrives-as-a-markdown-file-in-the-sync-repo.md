---
type: adr
id: ADR-0027
title: A meeting arrives as a markdown file in the sync repo, under a versioned contract
status: accepted
date: 2026-10-07
---

# ADR-0027 — A meeting arrives as a markdown file in the sync repo, under a versioned contract

## Context

James's meetings are written up by Google Meet's "Notes by Gemini" (earlier,
Granola). His n8n workflow already pulls them out of email and writes each
into a Notion "Meeting Notes" database: Meeting name, Date, Attendees,
Category (Standup, Retro, 1:1…), Source (`gemini` | `granola`) and Source ID.
The provider will change again — a bot-based notetaker is likely — and Atlas
must not care which. The Mac may be asleep when a meeting ends. Atlas pulls
the vault's GitHub repository every minute (ADR-0025), and external data
already arrives as notes (ADR-0012).

What the providers actually give (from James's Notion rows, 2026-10-06):

- **Gemini:** an Attendees list of `Name — email` lines, which can include
  group addresses (`platform-team@…`) that are not people; Summary; Next
  steps as `- [Owner Name] Title: description`; Details as `Topic: …`
  bullets; a transcript with a date line, **timestamps per section**
  (`### 00:09:44`), one `Speaker Name: text` line per turn with real names,
  ending `### Transcription ended after …` and a disclaimer line.
- **Granola:** **per-line timestamps** (`**[14:14:22] You:** …`) and speakers
  only `You` or `Remote Speaker`; next steps with an owner and a confidence
  (high / medium / low).

Three ways in were weighed: n8n calls Atlas's local API (needs the app
running and reachable; the API is `127.0.0.1` only, ADR-0016); Atlas polls
Gmail itself (a second OAuth surface and provider parsing inside Atlas); n8n
commits a markdown file into the sync repository.

## Decision

**n8n gains a second destination: it commits one markdown file per meeting
into the vault's sync repository, at `Inbox/Meetings/<YYYY-MM-DD> <title>.md`.**
The email parsing it already does is kept, not rebuilt. Atlas's pull brings
the file in like any other note. Atlas holds no Gmail login and no
provider-specific parser.

**The file obeys a versioned meeting import contract**
(`vault/docs/contracts/meeting-import-v1.md`, with a JSON Schema beside it):

- Frontmatter: `type: meeting`, `atlas_import: meeting/v1`, `title`, `date`,
  `start`, `end` (optional), `kind` (from Category), `provider`,
  `external_id` (from Source ID), and `attendees` as a list of
  `{ name, email?, group? }` — a group address is kept but never becomes a
  Person.
- Body sections, in order, each optional except Transcript when the provider
  has one: `## Summary`, `## Notes` (Gemini's Details), `## Provider next
steps` (owner kept as `[Owner]`, and confidence when given), and
  `## Transcript`.
- **Transcript: one block per speaker turn**, `**Speaker** [hh:mm:ss] words
^tNNNN`. The timestamp is the turn's own when the provider gives one, else
  the section's it fell under (marked `~`), else omitted. Block ids make
  every turn citable (ADR-0022). Speaker is a real name, `You` (read as the
  profile's name, ADR-0024), or `Unknown` for `Remote Speaker` and the like;
  an unknown speaker is never guessed into a Person.
- Provider boilerplate (the disclaimer, "Chat with meeting transcript" links)
  is dropped by the mapping.

**`external_id` makes import idempotent.** A file whose `provider` +
`external_id` the vault already holds is not a second meeting: Atlas marks
it `atlas_duplicate_of: [[…]]` and archives it (reversible), and nothing
downstream runs on it. A file that fails validation stays where it landed
with `atlas_import_error:` set and shows in the Inbox; it is never deleted
or silently fixed.

The validator is a pure domain function (`validateMeetingImport`); the
contract version is in the file so v2 can be read beside v1.

## Consequences

- Meetings arrive with the Mac asleep and are processed on its next pull.
- n8n needs push access to the vault repository — a fine-grained token or
  deploy key scoped to that one repository, kept in n8n, never in the vault.
- n8n only adds files, so the existing conflict rules (ADR-0025) suffice.
- Existing Notion Meeting Notes can be brought in once through the same
  contract.
- Work meeting content passes through n8n and GitHub: whether that is
  allowed for work data is James's call, recorded as an open question.

## As built (P28-01, 2026-10-07)

Accepted as written. The contract is `vault/docs/contracts/meeting-import-v1.md`
with `meeting-import-v1.schema.json`; the validator is `validateMeetingImport`
and `parseTranscript` in `packages/domain/src/meetings`. Where the build went
past or around the text above:

- **`transcript_clock: elapsed | wall`** (optional, default `elapsed`) was
  added to the frontmatter. Gemini's times count from the start of the
  recording and Granola's are the time of day; without the key a reader
  cannot tell `00:09:44` from `14:14:22` apart in meaning.
- **The validator is handed the YAML reader.** The domain has no YAML parser,
  so `validateMeetingImport` takes the text plus a `readFrontmatter` function;
  the app passes the one it reads every note with.
- **The JSON Schema covers the frontmatter only.** The body's rules (section
  order, turn grammar, block ids) are in the doc and the validator; a test
  holds the schema and the validator to the same verdict on the frontmatter
  of every fixture.
- **Unknown speakers are read leniently.** The mapping writes `Unknown`;
  Atlas also reads `Remote Speaker`, `Speaker 2`, `Guest` and the like as
  unknown, so a mapping that passes Granola's label through is not refused.
- **`attendees` is not a property of the Meeting type**, since no property
  kind holds a list of records; it stays in the file, and `people` is its
  editable, linked form.
- **The Meeting type is built in** (`BUILT_IN_TYPES`) and its file ships in
  this repository's vault. Nothing yet writes a built-in type's file into
  another vault; that is the "ensure built-in types" step ADR-0029 names, and
  meeting import on arrival (P28-04) depends on it.

After an adversarial pass and a review (2026-10-07), the contract was
tightened. It stays v1: no mapping writes files yet (#8), and most changes
refuse what the first build read wrongly. One does narrow the text: a
deeper heading that names a section (`### Notes`) was allowed and is now
refused.

- **The frontmatter is written with a YAML serializer**, or every string is
  single-quoted: titles and kinds are free text (`Q3: plan`, `Retro #4`,
  `1:1`), and pasted unquoted they read as something else.
- **A turn id is `^t` and a number, rising.** ADR-0022 allows any id; turns
  are narrowed to `^t0001`, `^t0002`, … (padding optional, gaps allowed) so
  a reordered or merged transcript is caught. A block id is used once in the
  whole file, not just among turns.
- **Each turn is its own paragraph.** Two turns without a blank line between
  are refused rather than read as one turn that loses the first id; so is an
  id anywhere in a turn but its end.
- **A bracket of digits right after the speaker is always the time**, so
  `[1:02]`, `[00:09:44.500]` or a time with no words is refused, never read
  as words. With `transcript_clock: wall`, a time is at most `23:59:59`.
- **A section's name at another level (`# Transcript`) and a code fence never
  closed are refused**, since both read as a meeting with no transcript.
  Fences close as CommonMark closes them. A section heading may carry a block
  id (`## Transcript ^h2k8d1`), as citing it writes one.
- **Next-step owners:** `[x]` is a checkbox and refused like `[ ]`; brackets
  inside an owner are kept, and a wikilink owner is kept as written.
- **YAML that cannot be expanded (an alias bomb) is reported as unreadable**,
  not as every key missing: `frontmatterProblem` now reports what turning
  the YAML into values throws, not only what parsing it does.
- **A blank profile name is no name**: `You` stays unnamed.

## As built (P28-02, 2026-10-07)

The n8n destination is in `tools/n8n/` (setup in its `README.md`). Where it
differs from the issue (#8) and the text above:

- **File locations.** The issue planned `vault/docs/contracts/n8n-meeting-to-atlas.md`
  and `.json` and `tools/validate-meeting.mjs`. They live together in
  `tools/n8n/` instead (`README.md`, `meeting-to-atlas.workflow.json`,
  `validate-meeting.mjs`), because the workflow JSON is generated from the
  mapper's TypeScript (`pnpm n8n:build`) and a test fails while the two
  differ. The contract stays in `vault/docs/contracts/`.
- **Atlas runs beside Notion, and never stops the run.** The branch is wired
  from the assembled meeting, before any Notion step (the People lookups and
  creates, the page write), and placed above the Notion branches so n8n's v1
  order runs it first: a Notion failure, or a meeting with no people, cannot
  keep it from running. It reads the meeting and the notes email by node
  name. Every node that can fail sends its item to an "Atlas commit failed"
  node, which emails the reason, instead of stopping, so the Notion write is
  never prevented. (#80 changed this from the first build, which was wired
  after the Notion page write.)
- **A Gemini start is never the email's arrival.** The day and any time come
  from the email's subject (a stated zone is converted, or the start marked
  approximate); otherwise the start is the arrival less the transcript's
  length, marked approximate. With no length to take off, the meeting is
  refused rather than given the arrival, which is about when it ended.
  (Amended 2026-10-25, #582: where DFAI maps a meeting sent to it — `POST
/v1/meetings` — a meeting with no start of its own takes its Google
  Calendar event's start and end before the arrival less the length is
  tried: the one event note of its title that ended at or before the
  arrival, within 3 hours of real time, measured on the clock the event
  notes are written on — the plan zone the vault keeps (#587, ADR-0046),
  else the Mac's. The day is the one the meeting states
  (subject, `date`, or a dated `start`); with none, the arrival's and the
  day before, so notes that arrive just after midnight find a late-evening
  event. The file says `start_source: calendar`. An `end` before a start
  read from the meeting or its event is refused, by the API and n8n's Code
  nodes alike, unless it has no date and the next day's keeps the meeting to
  12 hours (`23:30` to `00:15`). A worked-out start is the `end`, when sent,
  less the length. The Granola pull never asks: a Granola note always
  carries a start, and one without is refused before it is mapped. n8n's
  Code nodes have no calendar, so a commit is refused as before; every
  refusal now says what the sender can add.)
- **Instants need a time zone.** A date-time with `Z` or an offset is read on
  the clock of `timeZone` (default `America/Los_Angeles`); with none it is
  refused rather than kept as a UTC clock time. A date or time without an
  offset is kept as written.
- **The collision path names a hash**, `<date> <title> (<provider> <8 hex>).md`
  of provider + external_id, within 255 bytes with the date kept. A file
  already there is checked with the same duplicate rule; another meeting
  there, or a file GitHub sends without content (over 1 MB), is a failure,
  never a skip or a guess.
- **Known gap:** titles that differ only in case on one day are two GitHub
  paths but one macOS file name; the single-path lookup cannot see it.

## As built (P28-04, 2026-10-08)

Import on arrival is `importArrivedMeetings` and `catchUpMeetings` in
`packages/application/src/meetings`, run by `createMeetingImporter`. Where the
build went past or around the text above:

### Decision: every handled file carries its outcome

**Each file the import handles gets one frontmatter line,
`atlas_import_outcome: imported | duplicate | error`.** This departs from the
first build's rule that a valid first copy stays byte for byte. Two review
rounds showed that with nothing written, a file never handled and a file
handled and then edited, renamed, moved, unarchived or copied by a sync
conflict look the same. Outcomes then hung on an in-memory record of what
was heard and on guessing moves from names and digests. That memory is lost
on a restart and differs between Macs. The stamp puts the outcome in the
file, where every Mac reads the same thing. No other byte of the file
changes (ADR-0003). The stamp goes right after the `atlas_import:` line the
mapping always writes, not at the end of the frontmatter. A property added
on another Mac lands at the end, so the two are separate changes git merges
rather than a conflict. Keys the import already wrote are changed where
they are.

- **Its own key.** `atlas_import` already names the contract a file follows
  (`meeting/v1`), and the validator requires that value, so the outcome
  cannot share it. `atlas_import_error` and `atlas_duplicate_of` stay as the
  readable detail.
- **What a stamp means.** A file under `Inbox/Meetings/` with no outcome is
  an arrival not finished, whatever the change feed called it. `imported`
  and `duplicate` are never judged again: an edit, rename, move, unarchive
  or sync conflict copy of the file carries the stamp. `error` is checked
  again whenever the file changes, so a fix lets it in and restamps it
  `imported`. An outcome Atlas does not know, or one cleared by hand, is
  read as `imported`, and the file is left alone; the API says the same.
- **A sync conflict's copy is the person's.** A file named
  `… (conflict from <Mac>).md` (U-29) is the other Mac's version of a file
  both changed. It is never judged, never counted as a holder and never
  archived. Activity warns of it each time it is looked at, until the
  person merges it and deletes it.
- **Only the Mac that runs the automations writes stamps**
  (`sync.automationsHere`, as automations, U-29). Another Mac does nothing,
  and loses nothing by it. While the automations move from one Mac to the
  other, each Mac reads the setting on its own next sync, so for that
  window both may import. They still reach the same outcomes: the rules
  depend only on the files. They write the same values too, except the
  day an archived copy is stamped with. A copy's link is its original's
  path, so it is the same on both Macs. If the two Macs' writes do meet,
  the sync rules (ADR-0025) keep both.
- **It catches up.** When the import starts for a vault, once the index is
  ready, and when this Mac takes the automations over, it lists
  `Inbox/Meetings/` (hidden files and folders left out, as everywhere,
  ADR-0014) and settles every file without an outcome. "Ready" means ready
  since this vault opened: the window's index status is the last vault's
  until the new vault's sync starts. The change
  feed only says where to look. That covers a fresh index's first sync
  (P28-03's baseline), what was heard while another Mac imported, and a run
  that failed.

### The rules

- **Which copy is kept.** Among the notes holding a provider + trimmed
  external_id that are not stamped `duplicate` or `error`, and are not a
  sync conflict's copy: one already stamped `imported`, wherever it is, is
  the original. It counts by its stamp and its own keys, even when the
  person's additions mean it no longer follows the contract. An unstamped
  holder counts only when it follows the contract.
  Otherwise a meeting filed elsewhere comes first, then one in the Archive,
  then one in `Inbox/Meetings/`, then by path compared without case,
  Unicode composition or extension. So `<date> <title>` comes before its
  `… 2` and `(<provider> <hash>)` variants. Every other unstamped holder
  in `Inbox/Meetings/` is archived, then stamped `duplicate` where it lands
  and linked to its original by the original's path. Holders filed or
  archived elsewhere, and any already stamped, are left as they are.
- **A copy is moved before it is stamped.** A copy whose move fails stays
  unstamped and is archived when next looked at. So a `duplicate` stamp
  under `Inbox/Meetings/` only ever means the person brought the copy back
  from the Archive, and it is left there.
- **Holders are read, not taken from the index**, which lags the import's
  own writes. Ids are compared trimmed, in SQL and when read.
- **One file's failure is its own.** A copy that cannot be written (a pane
  typing in it, a refused write) is said against that copy. The original
  and the other copies still settle, and the unwritten one is settled when
  it next changes or at the next catch-up.
- **The error is one line**: the first three problems and how many more
  (`tools/n8n/validate-meeting.mjs` prints them all). A body problem names
  its section and its line, counted with the stamp already in the file, so
  writing it does not move what it points at. A file whose YAML cannot be
  read is never written to; Activity says why. It is looked at again when
  it changes.
- **Activity has a Meetings kind**: one line per outcome.
- **The Inbox.** This repository's vault ships an Inbox view that is an
  Atlas query over tasks and meetings: backlog tasks, anything under
  `Inbox/`, and any meeting with an import error, shown as a column. Its
  Meeting type declares the three keys so the query can name them and the
  properties panel shows them. **Another vault has neither until they are
  put there.** The import works without them, but its Inbox lists meetings
  only once its Inbox view says so and its Meeting type declares the keys
  (copy `.atlas/views/Inbox.md` and the three properties from
  `.atlas/types/meeting.md`). P30-01's Inbox page, which lists everything in
  `Inbox/` with each meeting's import outcome or error on its row, makes the
  view unnecessary, and the Inbox offers to add the three keys to a vault's
  own Meeting type (previewed, written only on a yes).
- **Known gaps:** a file that fails import and declares no `type: meeting`
  is stamped, but the shipped Inbox query cannot list it (`GET /v1/meetings`
  does, and so will P30-01's Inbox page). Files under `Inbox/Meetings/` that
  are not meetings are judged as arrivals and stamped `error`.

## As built (P28-07, 2026-10-08)

The meetings already in Notion come in once through
`tools/import-notion-meetings.mjs` (how to run it: `tools/n8n/README.md`).
Where it goes past the text above:

- **It writes into a folder, not through GitHub.** It reads a Notion
  "Markdown & CSV" export and writes into a vault folder it is named
  (`--vault`, no default; an empty one is refused), `Inbox/Meetings/` unless
  told otherwise. The folder may not be hidden, nor linked out of the
  vault. The files are the mapper's (P28-02), at the paths n8n would use, so
  Atlas takes them in as it takes n8n's.
- **A row is paired with its page by Source ID**, not by title: titles
  repeat (`1:1`). A row with no page, or with two, is refused, not guessed.
- **It checks each file with the validator before writing it**, and writes
  it whole under a hidden name, flushed, before linking it to its name. A
  name never holds part of a meeting, and no file is written over.
- **"Already in the vault" is P28-04's holder rule**, shared, not copied:
  `meetingHolding` in `packages/domain/src/meetings` decides for both the
  import on arrival and this tool. It is asked of the whole vault (hidden
  folders and sync conflict copies left out) before a row is mapped, so a
  second run writes nothing.
- **The Date cell is read as Notion shows it.** A time with no zone, or a
  zone other than UTC, is kept as written; a UTC time is an instant on the
  clock of `--time-zone`. A range is on one clock: a zone on either side is
  both sides'. A form that could be two days (`10/06/2026`) is refused.
- **Gemini's rows are held by default** (issue #44): their Date is when the
  notes arrived, near the meeting's end, written as local time marked UTC.
  `--gemini-dates arrival-local` reads it as local time and starts the
  meeting the transcript's last section stamp before it. meeting/v1 has no
  field for an approximate start, so Notes open with a line saying so.
- **Not carried over:** the Attendees relation (the page's Attendees
  section is read instead) and the other properties. A page section the
  workflow did not write goes into Notes under its own heading, and a
  transcript block is taken only at the page's top level, outside code; a
  `## Transcript` section is preferred to one.
- **Known gap:** a local time marked UTC cannot be told from a real UTC
  time from the export alone. For Gemini that is issue #44, handled above
  by choice, not by default; any other provider's would be moved by the
  zone's offset. The README's step 4 is the check to make on a vault copy
  before the real run.

## As built (#93, 2026-10-10)

The first option weighed above — n8n calling the local API — is now a
second way in, beside the commit, for a machine where n8n reaches the
running app: `POST /v1/meetings` (ADR-0016's section on it). The commit stays
the way in while the Mac is asleep or Atlas is closed.

- **The mapper is in the domain**, `packages/domain/src/meetings/mapping`,
  no longer in `tools/n8n`. The route runs it, the n8n Code nodes are
  compiled from it, and `tools/import-notion-meetings.mjs` imports it, so
  all three write the same file for the same meeting. The workflow's GitHub
  checks stay in `tools/n8n/github-file.ts`.
- **The route writes what n8n would commit**, at the same paths, and leaves
  the stamp to the import, as for a commit. "Already in the vault" is the
  import's holder rule, plus a read of the two paths, since the index lags.

## As built (P28-06, 2026-10-11)

Terminology correction is the first declared deterministic step (PLAN.md §11,
principle 6). It runs as the import lets a meeting in, in the same write as
the `imported` stamp, so a meeting is never synced half-settled.

- **Decision (James, 2026-10-11): only a Term's "misheard as" spellings
  rewrite text.** A Person's or a Company's `aliases` link attendees to them
  and are never used to correct; the vocabulary holds a person's or company's
  _name_ only, as a right spelling that protects itself. Matching is
  **case-sensitive, as the variant is written** (`mark` is not `Mark`; list
  both when both turn up): a Term holds a plain list of strings, so an
  "any case" flag was not cheap and is not offered. A common word that differs
  in case from a variant is therefore never touched, and shouted text is no
  longer shouted back.
- **What is corrected.** Domain `correctTerms(text, vocabulary)` over the
  Summary, Notes, Provider next steps and Transcript only. The text is read as
  words, runs of spaces and single other characters, and every 1..n-gram that
  starts at a word some variant starts with is looked up in a map keyed by the
  variant, so a text is read in time linear in its length however many terms
  there are (a 400-turn transcript by a 1000-term vocabulary: tens of
  milliseconds; the first build compiled one pattern of every spelling and
  took 18-23 s). The table is cached per vocabulary. The earliest match wins,
  then the longer; a right spelling matches too and is left as written. Two
  variants that run into each other (`Lark Spur` and `Spur Pay` in `Lark Spur
Pay`) correct only the first, and the second is not read: list the longer
  spelling as well to get both words right.
- **What a match may not touch.** A match needs a non-word neighbour on both
  sides, so `C#` is not found in `C#sharp`; a word joined to its neighbour by
  `-`, `.`, `/`, `@` or `\` (emails, domains, paths, `quill-based`) is left
  alone. A name of more than one word (a person's or company's, or a term's
  right spelling) is also found through a soft line break, `**emphasis**`,
  `*` or `~~`, so the variant `Quill` is not put inside `**Mara** Quill` or
  `Mara⏎Quill`. A variant with no letter or digit in it is refused when the
  vocabulary is built and shown as a warning on the Terms page, as is one that
  is a word of another note's right spelling (a lone `Quill` is corrected
  although `Mara Quill` is not). Wiki and markdown links (a target may hold
  balanced parentheses), URLs, tags, code spans and fences, comments and `^ids`
  are masked out before matching.
- **The record.** `atlas_corrections: [{ from, to, count, blocks, at }]`,
  `atlas_corrections_digest` and `atlas_corrections_original_digest`, written
  after `atlas_import:` like the stamp. `at` holds each change's offset in the
  corrected body, so undo is exact without keeping the original text. The
  digests are `correctionDigestOf`: the domain's FNV-1a (`digestOf`), a 53-bit
  mix of the same text and the length, about 90 bits in all, with no new
  dependency (a defence against hand edits, not against a crafted collision).
- **Undo** (`undoMeetingTermCorrections`) restores the original body byte for
  byte, refused when the body's digest is not the one recorded (frontmatter
  edits do not count), when any recorded spot does not read `to`, or when the
  body it rebuilds does not match the digest of the original (so a `from` or
  `at` edited by hand cannot write words the meeting never had; a record from
  the first build, which had no original digest, is refused too). It leaves
  `atlas_corrections: undone`; a meeting holding the key in any form is never
  corrected again, by the import or by `correctMeetingTerms({ path })`, the
  use-case the "after a meeting" pipeline (P29-06) calls as its step. The
  band over the meeting turns Undo off and offers Dismiss when the refusal
  cannot pass (the body no longer matches); unsaved typing or a note changed a
  moment ago leave it on.
- **Nothing to correct.** The import writes `atlas_corrections: none` in the
  same stamp write when the vocabulary holds a misheard spelling and the
  meeting held none, so the pipeline step never reads it again. It is not
  written while the vocabulary has no misheard spelling at all, so terms added
  later still apply. The pipeline step itself does not write that mark (an
  extra write per meeting for nothing): a meeting that did not pass through
  the import is read again each run, which is a linear scan.
- **Speaker labels** are corrected like the words: the label is what links a
  turn to a person, and a misheard speaker is the same mishearing. One
  exception came later: a label that is exactly what a person goes by is not
  turned into a spelling that is not theirs (see "As built, after the
  adversarial pass on the stack").

## As built (P29-04, 2026-10-11)

A meeting the import lets in is linked to its people, companies and likely
project: `matchAttendees` and `planMeetingLinks` in
`packages/domain/src/meeting-links`, run by the use-case `linkMeeting` in
`packages/application/src/meeting-links`, which the "after a meeting"
pipeline (#19) is to run as a deterministic step.

- **Sure links are written; the rest is proposed.** An attendee is matched
  by `email` or `other_emails` first — or an alias written as an address (#464: an old address kept among the aliases still matches) — then by name or alias (spelt as the
  vocabulary compares spellings, P28-05). Exactly one person is a link; two or
  more are a `link` proposal for each, never a guess; none is a `person`
  proposal with their name, address and the company their domain surely
  names. One person of that name whose address is not among those on file is
  a `link` proposal too, not a sure link: it may be someone else of the same
  name. A group address is never a person and never proposed; nor is the
  vault's owner, by their profile's name (as written, `Last, First`, any case
  or spacing) or by the addresses of their own Person note (the one whose name
  is the profile's). The profile holds no address, and the meeting contract
  marks no attendee as the organiser or the owner, so with no profile name
  set nobody is known to be the owner.
- **A company is sure only from a domain it declares.** From an attendee's
  domain: a company's `domains`, or its `site` when that is a root (a page
  below the root says where the company is, not whose domain it is); the most
  specific declared domain wins, so a subsidiary is not its parent, and two
  companies at the same depth claim nothing. Public mail providers (by their
  label, in any country: `gmail.co.uk`, `outlook.de`) and shared hosts
  (LinkedIn, YouTube, `*.zendesk.com`, `*.github.io`…) claim no one. A domain
  named like a company ("Fenn" for `fenn.example`) only _guesses_ it, and
  only for a company that declares no domain: that is a `link` proposal on
  `companies`, never a write. Companies also come from a linked person's
  `company`.
- **Speakers are linked too**, when a named speaker is exactly one person.
  It was cheap: the transcript is already parsed by the validator. The labels
  are read as heard first, then as the vocabulary corrects them (see "As built, the three
  together" below). An
  unmatched speaker is not proposed: a speaker has no address to tell two
  people apart, and the attendees are what proposals come from.
- **The project is only ever proposed**, for a meeting that has none: the
  open project (outside the Archive, not done, cancelled or dropped) tied to
  the most of its people and companies — by either note linking the other, or
  by another note naming both in `project` and `people`/`companies`.
- **It only adds, and records what it changed.** It writes `people` and
  `companies` of the meeting and nothing else, with each key's value before
  and after as an automation's log does (`DoneAction`), so `undoMeetingLink`
  puts back what is unchanged since and takes away its still-open proposals.
  Nothing in the app offers that undo yet — the run lives only as long as the
  import that made it, and a button needs it kept per meeting: it is said in
  Activity, and #19's pipeline is to log it in its rule's log, where "Undo
  last run" will call it. A relation holding something other than links is
  left as it is, and said.
- **It runs once per meeting, before the stamp.** The importer calls it
  (`beforeLetIn`) just before it stamps a file `imported` (an arrival, or a
  fixed error), never on later changes, so a person taken out of `people`
  stays out. Linking first means the links are in the version that arrives:
  a note-triggered rule (#92) hears a meeting at the stamp, so a `created`
  rule sees it linked, and no write follows the stamp to be heard as a user
  edit of a meeting that is in. A meeting whose linking failed is stamped all
  the same and not retried until #19's pipeline runs the step; Activity says
  it could not be linked.
- **Proposals are known by what they are for.** Each carries a `proposal_id`,
  looked up across the vault and the Archive, so running again proposes
  nothing twice and a rejection stays an answer. A person is known by their
  address alone, so rejecting "add X" once covers every later meeting (and
  accepting it links X to the meeting it came from only: a pending proposal
  is not made again for the next meeting). The others are known by the
  meeting's provider and id, which filing does not change, not by its path.
- **A proposal is input, and the meeting it names is found by what it is.**
  A proposal's payload names its meeting by path and records its provider and
  id (`meeting`). Filing moves the file and a newer meeting can take the
  old path, so accepting finds the note that holds that meeting — the
  index names where to look, the proposal's path and `source` are hints, and
  each candidate is read — and writes only there, never to the Archive, nor
  to a note a hand-edited `source` merely names. It refuses, in words, a
  meeting that is now only in the Archive, one that is several notes, and a
  path that holds another meeting; a meeting gone altogether still lets a
  person be made, and says a link is not there. The card names the meeting
  by its title, which filing does not change.
- **Proposals grew two things** (ADR-0028's proposals): a note proposal's
  `link_from: { note, property }`, so accepting a person makes them and adds
  them to the meeting; and a link proposal with no `digest`, judged on the
  relation alone — added to a list, or filling an empty single link, never
  replacing one — since the steps after linking change the meeting. A link
  proposal may name a meeting in `Inbox/Meetings/`: changing a note there
  makes no new file for the import to judge; only making a note there is
  refused.
- **Accepting a person is all or nothing, and never stuck.** If adding them
  to the meeting fails after the note was made, the note is taken back. A
  person already made, by another meeting's proposal for them, is linked
  rather than refused — but only if the note at their path is a person. A
  link that the meeting already holds in another spelling
  (`[[People/Sam Okoro|Sam]]` for `[[Sam Okoro]]`) is not added twice, for a
  link proposal as for a person. An attendee listed with and without an
  address is one person; an address written `Name <address>` on a person is
  read as the address.
- **Person and Company gained `other_emails` and `domains`** in this
  repository's vault. Matching reads them whether or not a vault's types
  declare them.

## As built, the three together (#92, P28-06, P29-04, 2026-10-11)

The race fix, the correction and the linking were built on separate branches
and meet in `letIn` (`packages/application/src/meetings/meeting-files.ts`).
For one meeting the import does this, in this order, and nothing else:

1. **Link** (`beforeLetIn`): one write of `people` and `companies` when
   something is sure, and the proposals, each a new note in the Inbox.
2. **Correct and stamp**: one write that puts the misheard spellings right,
   records them (`atlas_corrections…`) and stamps `atlas_import_outcome:
imported`.

- **No write follows the stamp.** Where meeting files land a note is not in
  play until it carries `imported` (#92, `eventWhereMeetingsLand`), so the
  link write sets no rule off, the stamp write is the meeting's one `created`,
  and neither is ever a `changed`. A rule set off by a meeting being created
  therefore sees it corrected and linked, once. A sync between the two writes
  reports an unstamped file, which is nothing to a rule.
- **Linking reads the speakers as corrected.** The link write comes before
  the corrections are on disk, so `linkMeeting` reads the transcript through
  `meetingTextAsCorrected`: the text as the vocabulary would correct it, in
  memory, nothing written. A turn labelled `Tobias Fen` that a Term puts right
  links Tobias Fenn. A meeting already corrected, found clean or undone is
  read as it is, so linking gives the same people whichever of the two steps
  runs first, which the "after a meeting" pipeline (#19) may rely on.
  Attendees are frontmatter, which the correction never touches.
- **Aliases link, Terms correct.** P28-06 took a person's and a company's
  `aliases` out of the vocabulary. Linking never read them from there: its
  directory (`compileLinkDirectoryQuery`) reads `aliases` from the Person and
  Company notes, so an attendee named by an alias is still linked, and the
  alias still rewrites nothing. Since #400 a Person or Company note may also
  carry `variants`, which correct to its name as a term's do: a term named
  like one is added there, since its own note would take the name's links.
  `aliases` still only link.
- **Undo corrections is not stopped by the links.** Its digests are of the
  body alone; linking, a proposal accepted later, or a rule setting a property
  change only the frontmatter.
- **Why two writes and not one.** Linking records each relation's value
  before and after so it can be undone, through the same writer automations
  use; folding it into the stamp write would have meant a second way to set
  a relation. Two writes before the stamp cost nothing a rule or the person
  can see. If the stamp write is refused (unsaved typing, a change since),
  the meeting stays unstamped with its links, and the next look links
  nothing twice and stamps it.
- **Tests.** `meeting-arrival-sequence.test.ts` (application, over the fake
  vault, the feed measured after every write) and `e2e/meeting-arrival.spec.ts`.

## As built, after the adversarial pass on the stack (2026-10-11)

An adversarial pass over the four stacked changes found five things in the
import and in accepting a proposal. Each has a test that failed first
(`meeting-arrival.stack.adversarial.test.ts`,
`accept-redelivered-meeting.adversarial.test.ts`,
`meeting-corrections.speakers.test.ts`).

- **Accept writes only to the meeting the import let in.** A proposal's
  meeting is found by its provider and id, and more than one note can hold
  those: the meeting, filed, and the same meeting delivered again at the path
  it first landed at — which is the path the proposal still names. Only a
  holder stamped `imported` is the meeting; an unstamped one is an arrival
  not finished, and may be about to be archived as a copy. So accepting
  chooses among the holders stamped `imported` (the proposal's path and
  `source` only break a tie between them), and when the only note holding the
  meeting is unstamped it refuses in words: the meeting "has not been let in
  by the import yet". A holder stamped `duplicate` or `error` holds nothing,
  as before.
- **Catching up compares the files it listed with each other.** Holders were
  named by the index alone, which is behind the folder after a pull: with two
  files of one meeting waiting and neither read yet, each was let in as the
  only one. A run now also reads which meeting each file it was handed names
  (once a run, from the frontmatter) and counts those as places to look —
  each still read and judged by `holdingAt`, as the index's are. The ordering
  rule is unchanged, so `<date> <title>` is let in and its `(<provider>
<hash>)` twin is archived as its copy.
- **Decision: in a speaker label, what a person goes by wins over a Term.**
  A turn's label that is exactly a person's name or alias names that person.
  Linking tries each label as heard first, and only one that is nobody's as
  the vocabulary corrects it. The correction leaves such a label as heard
  where a Term would turn it into a spelling that is not that person's —
  `Toby`, Tobias Fenn's alias, is not made the product `Tobi` in a label,
  though it still is in the words — and still puts it right into one that is
  theirs (`Mara Quil` into `Mara Quill`). This is the one place an alias
  bears on correction, and it only ever stops a rewrite: aliases still
  rewrite nothing (P28-06's decision stands). The vocabulary carries who goes
  by what (`speakers`) for this; it is read by the same index query.
  Companies are not speakers and are not counted.
- **Activity is truthful when the proposals cannot be written.** The links
  are written first. If the Inbox then cannot be listed or written, the line
  says who was linked and "its proposals could not be written: …" (a
  warning), not "Could not link the meeting"; the run is kept with what it
  set (`unproposed` holds the reason), so an undo still has its record.
- **A half-written arrival, a changed vault, one vocabulary.** If the link
  write lands and the stamp write fails, the meeting stays unstamped with its
  links, and the next look stamps it and links or proposes nothing twice
  (now tested). If another vault is opened while a meeting is being linked,
  the meeting is not stamped: `beforeLetIn` reports `vault-changed`, Activity
  says so, and it is let in when its vault is next open. The run's vocabulary
  is read before `beforeLetIn` and handed to it, so the speakers are read by
  the very spellings the stamp write corrects by, and the index is asked once.

## As built, with a rule's Claude step behind it (P29-03 stacked on the three, 2026-10-11)

A rule that asks Claude "when a meeting is created" is the fourth step, and
the import does nothing new for it: the step runs on the stamp write's
version, so it reads the meeting linked and corrected, once; a duplicate is
archived unheard; and nothing the import writes is a `changed`. A proposal
the step makes can link back to the meeting by the same `link_from` and
`meeting` identity a person proposal carries — added by Atlas for the meeting
the proposal cites, never taken from the model's answer. See ADR-0028, "One
writer, and the meeting a proposal came from".

- **Tests.** `claude-step.meetings.test.ts` (application, the same fake vault
  and feed) and `e2e/claude-meeting.spec.ts`.

## Amendment: Atlas pulls Granola (P28-08, 2026-10-13)

ADR-0034 (proposed) reverses this record's rejection of "Atlas polls the
provider" **for Granola only**: Granola's REST API takes a bearer key, so there
is no OAuth surface, and the parsing is the shared mapping, so it is written
once. Gmail stays rejected, Gemini stays on n8n, and a further provider needs
its own record. What stands: the contract, the file's place, and idempotence by
`provider` + `external_id`.

The contract (v1, unchanged in what it accepts and refuses) gains, for that
mapping:

- **`MeetingFields.turns`**: a provider's turns, structured (speaker, time,
  words), written as the same transcript blocks without being rendered to
  text and read back.
- **`MeetingFields.clock`**: `elapsed` or `wall`, written as
  `transcript_clock`.
- **`source_url`**: a link back to the meeting in the provider's app.
  Named in `meeting-import-v1.md` now, and in the schema and contract test
  with the mapper (P28-09).

## Amendment: a copy can come from another provider, and a Mac can be asked to take over (ADR-0035, ADR-0036, 2026-10-14)

Three statements above change. Both records are proposed. This amendment takes effect when ADR-0035 and ADR-0036 are accepted.

- **"A file whose `provider` + `external_id` the vault already holds is not a
  second meeting."** That is no longer the only way two files are one meeting.
  A file from a **different provider** on the same date is also a copy when
  the rule in ADR-0036 matches it: half-open time windows overlap, attendee
  emails overlap (Jaccard 0.5 or more, the owner and group addresses left
  out), and **at least one shared attendee other than the owner**, so
  owner-only meetings never match. The rule, its **provisional** thresholds
  and the spike (S1) that fixes them before anything is archived are in
  ADR-0036; they are not repeated here. What happens to a match is unchanged
  from "Which copy is kept" above: the original is the one already imported,
  else the existing order; the copy is archived, stamped `duplicate` and
  linked with `atlas_duplicate_of`; nothing runs on it. Holders still come
  from reading the files, not the index. A copy that is a conflict copy,
  `duplicate` or `error`, or in the Archive, is not a candidate.
- **"`imported` and `duplicate` are never judged again: an edit, rename, move,
  unarchive … carries the stamp."** One exception: **unarchiving a copy that
  the cross-provider rule archived restamps it `imported` and removes its
  `atlas_duplicate_of`**, so a wrongly matched meeting is processed like any
  arrival. Same-provider copies are unchanged.
- **"Only the Mac that runs the automations writes stamps."** Still true, and
  no Mac takes the automations by itself. ADR-0035 has a Mac that is not named
  say that meetings are waiting, and offers a one-click "Process here" that
  names that Mac. **It catches up.** The import's catch-up above already runs
  when a Mac takes the automations over, so a claim settles every file
  without an outcome (`use-meeting-import.ts` clears its `caughtUp` while the
  Mac is not the importer and reruns on becoming it). The Claude step's
  catch-up (`missedArrivals`, ADR-0028) is once per vault opened and is not
  reset today; ADR-0035 resets it when `scheduled` goes false to true, so a
  claim mid-session does not wait for the next open. ADR-0035 also has every
  Mac, the named one included, run the import only after a pull completed
  since launch or wake, and only if it is still named after that pull.

Meetings already imported as two originals are not touched on arrival; the
sweep in ADR-0036 handles them.

## Amendment: meetings arrive in their month, and waiting is a state (ADR-0038, #214, 2026-10-14)

- **Where.** The mapping writes `Meetings/<YYYY>/<MM>/<YYYY-MM-DD> <title>.md`
  (and the second copy's `… (<provider> <hash>).md` beside it), the month
  from the meeting's `date`. `Inbox/Meetings/` is still read as a place
  meeting files land: an n8n workflow not re-imported keeps writing there,
  and every file in it is still the import's, as below.
- **Whose.** In a month folder under `Meetings`, a file is the import's when
  it declares `atlas_import` or already carries `atlas_import_outcome`
  (`isMeetingArrival`). Everything above about "a file under
  `Inbox/Meetings/` with no outcome" holds for such a file there: it is
  pending, not in play to rules until it is let in, and judged on every look.
  A meeting made by hand in its month declares nothing: the import never
  looks at it, and it is in play from the start. A folder of meetings filed
  some other way, `Meetings/From Notion`, is not a month folder and is not
  where meeting files land.
- **Which copy is kept** is unchanged, and still decided by what the files
  say: provider + `external_id`, the one already imported first.
- **Waiting in the Inbox** is no longer the folder. A meeting waits while it
  declares `atlas_import`, was stamped by the import or is arriving in its
  month, is out of the Archive, and has no `project` — wherever it lives.
  Processing it writes the link and moves nothing.
- **The index** asks for the stamps, and for which notes declare the
  contract, only where meeting files land: both folders.

## As built: a failed link is marked, and Run now links it again (#192, 2026-10-30)

"A meeting whose linking failed is stamped all the same and not retried until
#19's pipeline runs the step" is now closed as follows, without the pipeline:

- **The stamp says so.** When linking a meeting fails as it is let in, the one
  stamp write also carries `atlas_links: failed` (`linkBeforeLetIn`). Nothing
  is written after the stamp, as before. A meeting linked once never carries
  it, so it is never linked again by this, and a person taken out of its
  `people` stays out.
- **The "After a meeting" rule links it again.** Its dry run (and the API's,
  as `plan.notLinked`) lists the meetings its query matches that carry the
  mark, at most 50 a run; its **Run now** links them with the import's own
  linker before it plans, so Claude reads each one linked. The decision is
  the domain's (`meeting-relink.ts`): only `apply: mine` relinks; a meeting
  is settled when the run left nothing of its own (unsaved typing, a
  relation changed since it was read, a directory note it could not read),
  and only then is the mark taken out. Linking adds only what is missing,
  so a second try links nothing twice. Scheduled and note-set-off runs do
  not relink: a write after the stamp is the person's to ask for.
- **Not in the rule's log.** The relink is said in Activity, a line per
  meeting as the import says it; "Undo last run" does not take it back.
- **Activity groups a meeting's lines.** A rule's run line names the notes it
  heard (`ActivityReport.notes`, kept in the file only when present); a run
  that heard exactly one meeting goes under it with the meeting's import and
  linking lines (`groupActivity`). Glossary term suggestions (#19) are out of
  scope.
