---
type: doc
---

# Meeting import contract, v1

How a meeting gets into DFAI, whichever notetaker wrote it up (ADR-0027).
Something outside DFAI — today an n8n workflow reading Google Meet's "Notes
by Gemini" emails, earlier Granola — writes **one markdown file per meeting**
and commits it to the vault's sync repository at
`Meetings/<YYYY>/<MM>/<YYYY-MM-DD> <title>.md`, the month's folder for its
`date` (ADR-0038). DFAI pulls it in like any other
note and checks it against this contract. DFAI holds no provider login and no provider-specific parser, with one
exception: Granola, whose API DFAI polls itself with a personal key (ADR-0034).
Even then the parsing is the shared mapping's job, not the app's: it runs the
same mapping in the app and writes the same file, so nothing below depends on
which of the two wrote it.

- **This page** is the contract in words.
- **`meeting-import-v1.schema.json`**, beside it, is a JSON Schema (draft
  2020-12) for the frontmatter, read as JSON. A mapping can check a file
  against it before committing. It says nothing about the body.
- **`validateMeetingImport`** (`packages/domain/src/meetings`) is what DFAI
  runs: the frontmatter and the body. The schema and the validator are held
  to the same verdict on every fixture by a test
  (`packages/adapters/src/markdown/meeting-import-contract.test.ts`).
- **Fixtures**: `packages/domain/src/meetings/fixtures/valid/` holds a
  Gemini-shaped and a Granola-shaped meeting that pass; `invalid/` holds one
  file per way to fail.

A file that fails is never deleted or silently fixed: it stays where it
landed with `atlas_import_error:` set, and shows in the Inbox (P28-04).

**Where a file lands, and when it is the import's** (ADR-0038). In a month's
folder under `Meetings` — `Meetings/2026/10/` — a file is the import's when it
declares `atlas_import`; a meeting someone writes there by hand, without it,
is left alone. A second copy of a meeting goes beside the first as
`<YYYY-MM-DD> <title> (<provider> <8 hex>).md`. The older
`Inbox/Meetings/<YYYY-MM-DD> <title>.md` is still read: every file there is
the import's, as it always was. A meeting waits in the Inbox, wherever it
is, until it is filed under a project; filing writes `project` and moves
nothing.

## An example

```markdown
---
type: meeting
atlas_import: meeting/v1
title: 'Platform weekly sync'
date: '2026-09-29'
start: '10:00'
end: '10:30'
kind: 'Standup'
provider: gemini
external_id: 'gemini-7f3a9c21'
transcript_clock: elapsed
attendees:
  - name: Mara Quill
    email: mara.quill@example.com
  - name: platform-team
    email: platform-team@example.com
    group: true
---

## Summary

Mara and Tobias agreed to ship the new cache behind a flag.

## Notes

- Cache rollout: the new cache is ready; Tobias wants a flag on it first.

## Provider next steps

- [Tobias Fenn] Flag the cache: put the new cache behind a flag before Friday.

## Transcript

**Mara Quill** [~00:00:00] Morning. Shall we start with the cache? ^t0001

**Tobias Fenn** [~00:09:44] Yes. It's ready, but I'd like a flag on it first. ^t0002
```

## Frontmatter

**Write the frontmatter with a YAML serializer** (`yaml`'s `stringify`,
js-yaml's `dump`), never by pasting values into a template. If a mapping
does build the text itself, it must **single-quote every string value** and
double each `'` inside one (`'Mara''s 1:1'`). A provider's title or kind is
free text, and unquoted it breaks the block or changes meaning: `Q3: plan`
(`: `) is a map, `Retro #4` loses everything after `#`, `[draft] notes` is
a list, `*standup` and `&ops` are an alias and an anchor, `'s sync` opens a
quoted string it never closes, and a `kind` of `1:1` is a number to a YAML
1.1 reader. A file whose frontmatter does not read is refused as unreadable;
one that reads as something else is refused key by key.

Quote dates, times and ids. DFAI's YAML reader keeps `2026-09-29` and
`10:00` as text, but other readers do not: js-yaml (which n8n uses) turns an
unquoted date into a timestamp, a YAML 1.1 reader turns `10:00` into a
number, and an id of digits is a number to every reader. A value of the wrong kind is refused, not converted.

| Key                 | Required | What it holds                                                                                                                                  |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`              | yes      | `meeting`.                                                                                                                                     |
| `atlas_import`      | yes      | `meeting/v1`: the contract the file follows. A v2 is read beside v1, never instead of it.                                                      |
| `title`             | yes      | The meeting's name, as the provider gave it. Not blank.                                                                                        |
| `date`              | yes      | The day, `YYYY-MM-DD`, and a day the calendar has (no 30 February).                                                                            |
| `start`             | yes      | Local start time, 24-hour `HH:MM`.                                                                                                             |
| `start_approximate` | no       | `true` when the mapping worked `start` out rather than read it: a Gemini email's arrival less the transcript's length. DFAI does not read it.  |
| `start_source`      | no       | `calendar` when `start` was read off the meeting's Google Calendar event, for a meeting that stated no time (#582). DFAI does not read it.     |
| `end`               | no       | Local end time, `HH:MM`.                                                                                                                       |
| `kind`              | no       | What sort of meeting: the Notion "Category" (Standup, Retro, 1:1…). Free text, not blank.                                                      |
| `provider`          | yes      | Who wrote it up, lowercase: `gemini`, `granola`, or the next one.                                                                              |
| `external_id`       | yes      | The provider's own id for the meeting (the Notion "Source ID"), as text. `provider` + `external_id` is what makes a second copy a duplicate.   |
| `transcript_clock`  | no       | What the transcript's times count: `elapsed` (time since the recording started — Gemini) or `wall` (time of day — Granola). Default `elapsed`. |
| `source_url`        | no       | A link back to the meeting in the provider's own app (Granola's `web_url`), `https://`. DFAI does not read it. Lands with P28-09.              |
| `attendees`         | no       | A list of `{ name, email?, group? }`. See below.                                                                                               |

`null` (a key written with no value, `end:`) is the same as leaving the key
out. Keys this table does not name are allowed and left alone: DFAI writes
its own (`atlas_import_error`, `atlas_duplicate_of`, and the links `people`,
`companies`, `project` when the meeting is linked).

### Attendees

Each entry is a map with these keys and no others:

- `name` — required, not blank. For a group address with no display name,
  use the address's local part (`platform-team`).
- `email` — an address, when the provider gives one.
- `group` — `true` for a group or list address (`platform-team@…`). A group
  is kept as an attendee and **never becomes a Person**. Leave it out for a
  person.

Gemini's attendee lines read `Name — email`; the mapping splits each into a
`name` and an `email`. A line of text in the list is refused.

## Body

Up to four `## ` sections, **in this order**, each optional:

1. `## Summary` — the provider's summary, as markdown.
2. `## Notes` — Gemini's "Details" (`Topic: …` bullets), or any provider's
   longer notes.
3. `## Provider next steps` — one item per line (below).
4. `## Transcript` — one block per speaker turn (below). Required when the
   provider has a transcript; when it has none, leave the section out — a
   Transcript heading with nothing under it is refused.

Headings match without regard to case, and may end in a block id
(`## Transcript ^h2k8d1`, which DFAI writes when something cites the
heading).
Any other `## ` heading, a section written twice, or one out of order is
refused, and so is a section's name at another level (`# Transcript`,
`### Notes`): it would otherwise be read as no section at all. Text before
the first section (a `# Title`, say) is allowed and left alone; DFAI puts
its own summary there once the meeting is let in (ADR-0036): a callout
between `<!-- atlas:summary v1 -->` and `<!-- /atlas:summary -->`, which a
provider never writes; deeper
headings that name no section, and anything inside fenced code, belong to
the section they are in.

A code fence closes as CommonMark closes it: with the same character
(`` ` `` or `~`), at least as many of them, and nothing after. A fence never
closed is refused, since it would hide every section after it.

### Provider next steps

Each non-blank line is a list item:

```markdown
- [Owner Name] Title: description
- [Owner Name] Title: description (confidence: high)
- Title: description
```

- `[Owner Name]` is who the provider said owns it, as written, followed by a
  space. Brackets inside it are kept (`[Mara [PM]]` is owned by `Mara [PM]`),
  and an owner written as a wikilink is kept as written, brackets and all
  (`[[Mara Quill]]`). Leave it out when the provider named
  nobody. A blank `[ ]` and a ticked `[x]` or `[X]` are refused: they read
  as a task-list checkbox, not an owner — a provider's "done" mark is not an
  owner and is left off.
- `(confidence: high|medium|low)` at the end, after a space, when the
  provider gives one (Granola does); a full stop after it is allowed.
- The step must say something after the owner.

These are the provider's suggestions, kept as they were. What becomes a task
is decided later, in DFAI (P29).

### Transcript

One block per speaker turn. **Each turn is its own paragraph, with a blank
line before the next**: two turns on consecutive lines are one paragraph to
every markdown reader, so the first turn's id would end in the middle of a
paragraph and cite nothing. DFAI refuses a line inside a turn that starts
`**Name**`, and a block id anywhere in a turn but its end.

```markdown
**Speaker** [hh:mm:ss] words ^t0001
```

- **Speaker**, in bold, is one of:
  - a real name, as the provider gave it (Gemini);
  - `You` — the vault's owner, read as the profile's name (ADR-0024). With no
    name in the profile it stays `You`; it is never guessed;
  - `Unknown` — anyone the provider could not name. Write `Unknown` for
    Granola's `Remote Speaker`. DFAI also reads `Remote Speaker`,
    `Unknown speaker`, `Speaker`, `Guest` and `Participant`, each alone or
    with a number or a single letter (`Remote Speaker 2`, `Speaker A`), as
    unknown.
    An unknown speaker is never guessed into a Person.
- **The time**, after the speaker:
  - `[00:09:44]` — the turn's own time, when the provider gives one per turn
    (Granola: `**[14:14:22] You:**` becomes `**You** [14:14:22]`);
  - `[~00:09:44]` — the time of the section the turn fell under, when the
    provider stamps sections and not turns (Gemini's `### 00:09:44`), marked
    `~` as approximate;
  - nothing at all, when there is no time.

  Hours are two or more digits; minutes and seconds are `00`–`59`. With
  `transcript_clock: wall` the time is a time of day, `00:00:00`–`23:59:59`.
  A bracket right after the speaker that opens with a digit or a colon
  (after an optional `~`, `-` or spaces) and holds only digits, `:`, `.`,
  `~`, `-` and spaces is always the time, so it must be a valid one:
  `[1:02]`, `[00:61:00]`, `[00:09:44.500]`, `[-00:00:01]` and `[~ 00:09:44]`
  are refused. The time is followed by a space and then the words; a time
  with no words after it is refused. Brackets holding words (`[laughs]`)
  are words.

- **The words** — one or more lines of text.
- **The block id** at the end (ADR-0022): it is what makes every turn
  citable. A turn without one is refused; DFAI never makes one up, since an
  id that is not in the file cannot be linked to. A turn id is `^t` and a
  number, and each turn's number is higher than the one before: write
  `^t0001`, `^t0002`, … (the padding is not required, and a gap is allowed;
  `^t2` after `^t0001` is fine, `^t1` after `^t2` or `^abc123` is refused).
- **A block id is used once in the whole file**: a Summary paragraph, a
  note, a next step or a heading may carry one (DFAI adds them when
  something cites a block), but never one a turn or any other block has.

A provider that gives its turns already structured (Granola's API does:
speaker, text, start and end instants) is written as these same blocks
directly. The mapping does not render the turns to text and read them back,
which would make a name holding `:` ambiguous. A `*` or a newline in a name
cannot be written in a speaker (`**Name**`), structured or not, so the mapping
replaces them. The file is the same either way.

Every block in the section must be a turn: the provider's date line, its
`### 00:09:44` section markers and its `### Transcription ended after …` line
are dropped by the mapping (the section time moves into each turn as `~`).

### Dropped by the mapping

Provider boilerplate never reaches the file: Gemini's disclaimer, "Chat with
meeting transcript" links, and the transcript's own date and end lines.

## From each provider

| Provider's layout                                       | In the file                                                |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| Gemini: Attendees `Name — email` lines                  | `attendees`: `{ name, email }`, `group: true` for lists    |
| Gemini: Summary                                         | `## Summary`                                               |
| Gemini: Details, `Topic: …` bullets                     | `## Notes`                                                 |
| Gemini: Next steps, `- [Owner] Title: description`      | `## Provider next steps`, as written                       |
| Gemini: `### 00:09:44`, then `Speaker Name: text` lines | `**Speaker Name** [~00:09:44] text ^tNNNN`                 |
| Granola: `**[14:14:22] You:** text`                     | `**You** [14:14:22] text ^tNNNN`, `transcript_clock: wall` |
| Granola: `**[14:14:40] Remote Speaker:** text`          | `**Unknown** [14:14:40] text ^tNNNN`                       |
| Granola: next steps with an owner and a confidence      | `- [Owner] Title: description (confidence: high)`          |
| Granola API: note `id`                                  | `external_id`, `provider: granola`                         |
| Granola API: turn `name`, else `me` (the note's owner)  | `**Name**`, else owner (`**You**` if vault's person)       |
| Granola API: turn `start_time`, an instant              | `[hh:mm:ss]` in the vault's zone, `wall`                   |
| Granola API: `web_url`                                  | `source_url` (lands with P28-09)                           |
| Notion Meeting Notes: Category / Source / Source ID     | `kind` / `provider` / `external_id`                        |

The Granola API rows describe the mapping DFAI runs when it pulls Granola
(ADR-0034); it lands with P28-09.

## Versions

`atlas_import: meeting/v1` is this page. A change that would refuse a file
v1 accepts, or read one differently, is v2, with a page and a schema of its
own; DFAI reads both. Naming `source_url` or `start_source` is not such a change: v1 already
allowed keys it does not name, and what it accepts and refuses is the same.
