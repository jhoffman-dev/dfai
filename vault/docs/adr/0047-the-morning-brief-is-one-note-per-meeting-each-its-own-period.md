---
type: adr
id: ADR-0047
title: The morning brief is one note per meeting, each its own period
status: proposed
date: 2026-10-25
---

# ADR-0047 — The morning brief is one note per meeting, each its own period

## Context

#39 (P32-08) asks for a pre-read for each of today's meetings, waiting for
James in the morning. Everything it needs exists: scheduled rules and the
Claude step with `output: note` (ADR-0028, P29-03), one note a period and
cited items (ADR-0028's #40 amendment), `brief()` (P32-04), and today's
meetings as event notes linked to people and companies (ADR-0046). The #40
amendment already said a rule may write one note per item of a period, with
the item in the period's record, "a brief per meeting of the day".

## Decision

**A preset, opt-in.** "Morning brief" is the fifth ready-made rule:
`daily at 07:00`, no query, a Claude step with the shipped prompt
`.atlas/prompts/morning-brief.md`, `output: note` into `Inbox/Briefs`, and
`data: meeting-briefs`. Like the other presets it is offered on the
Automations page and runs only once the person creates it.

**Which meetings.** `readDayMeetings` for the day (ADR-0046): timed event
notes not marked `gcal_missing` and not declined, each event once. Of those,
the ones with at least one linked person or company (`meetingsToBrief`). A
day with none writes nothing: no empty brief.

**What Claude is handed.** For each meeting, its own ask: the meeting (its
event note, its time, its meeting note) and, for each linked person and
company, what `readBrief` says on that day — open tasks, waiting-fors,
follow-ups, the last meeting with its tasks and decisions, decisions and
recent mentions — as `<vault_data>` sections, each line linking its note
(`meetingBriefData`, built on the citation helpers the Friday review uses,
now `automations/cited-data.ts`). A linked note that is gone or is not a
page is named in the data and linked nowhere. The answer goes through
`keepCitedItems`: a list item that links no note it was handed is left out.

**Where and what it is called.** `Inbox/Briefs/<day>/<HH.MM> <title>.md`, so
the brief waits in the Inbox (the Inbox lists notes under `Inbox/`). DFAI
names the note, not the model. `planNote` numbers past a name already taken,
so a brief never writes over a note.

**The key: the day's slot and the event.** Each brief is its own period:
`{ slot: "<day>T07:00:00", item: "gcal:<event id>" }`, or the event note's
path for an event note that names no id. It is recorded where #40 records a
period, in both places that each work alone: the run's log entry (one entry
per meeting, `- period "…" for "gcal:…"`) and the brief's own frontmatter
(`atlas_period`, `atlas_period_item`, `atlas_period_rule`). The event id is
the same on both Macs, so a brief synced in from the other Mac counts as
made; the folder searched for stamped briefs is the day's own, so the check
does not grow with every brief ever written. A scheduled run never writes a
brief the log or a note records, even one deleted since; Run now writes
afresh one whose note is gone, as for #40. The period is read again after
Claude answers and before the write: a brief that synced in meanwhile means
nothing is written.

**One writer.** Nothing new: scheduled Claude runs are already held to the
Mac that runs the vault's automations (`gatedByFreshPull`, ADR-0035), as the
meeting notes are (ADR-0046).

**A missed 07:00.** The scheduler's catch-up rule stands (a slot missed
while asleep or closed runs once, on the next tick). The brief briefs the
slot's day only while it is still that day (`briefDayOf`): a slot caught up
the next morning briefs nothing, and is logged as a run so its schedule
counts on from it.

**One failure, the rest still briefed.** Each meeting's ask is its own
`runClaudeStep`, and each is logged as its own entry. A provider failure on
one is a `failed` entry for that meeting, naming it, which wrote nothing;
the others go on. Each entry is said once in Activity. At most ten meetings
are briefed in one run (one ask each); the rest are logged as left, for Run
now.

**The clock.** "Today" and 07:00 are the Mac's wall clock, the clock the
scheduler and the Today page already use. ADR-0046 writes event times on the
primary calendar's zone, which is the Mac's except on a trip; the zone it
used is not stored anywhere, so the brief cannot read it. Storing it is left
open (below).

## Consequences

- A brief is a note: `/v1/notes`, `/v1/query` and the MCP note tools read it.
  No route or tool is added; the rule's `data` value appears in
  `GET /v1/automations` and `atlas_automations` as any other.
- Briefs accumulate under `Inbox/Briefs/`, one folder a day, until filed or
  archived.
- A rule's log holds up to 100 entries; a busy day writes one per meeting.
  The briefs' own stamps keep the record when old entries are dropped.

## Still open

- Storing the zone a meetings sync used, so a Mac abroad briefs on the
  calendar's day rather than its own.
- A brief moved out of its day's folder, with its log entry also gone, is not
  found, and that meeting could be briefed again that day.
