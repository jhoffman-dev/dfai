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
names the note, not the model, and a title that cleans away to nothing (`.`,
`..`) is `Meeting`. `planNote` numbers past a name already taken, so a brief
never writes over a note; the names taken grow with each brief the run
writes, so two meetings of one start and title get `… 2`.

**DFAI alone sets a brief's properties.** The answer's `properties` are
ignored for this preset: an invitee's event title is data handed to the
model, and could ask it to answer with `date` and `gcal_event_id`, which
would make the brief read back as a meeting, or as a declined twin hiding
one. The brief carries only its period stamps. As defence in depth, a note
carrying a brief's stamps (`atlas_period_item` or `atlas_period_rule`), or of
type `block` in any case (a time block carries its event's id, ADR-0030), is
never an event note: not to the day's meetings (`compileDayEventsQuery`) nor
to a meetings sync (`notesById`), which say so with one rule
(`not-event-notes.ts`). Nothing requires `type: event`: `type` is the
person's key (ADR-0046), and an event note retyped by hand stays the event's.

**The key: the day's slot and the event.** Each brief is its own period:
`{ slot: "<day>T07:00:00", item: "gcal:<event id>" }`, or the event note's
path for an event note that names no id. It is recorded where #40 records a
period, in both places that each work alone: the run's log entry (one entry
per meeting, `- period "…" for "gcal:…"`) and the brief's own frontmatter
(`atlas_period`, `atlas_period_item`, `atlas_period_rule`). The event id is
the same on both Macs, so a brief synced in from the other Mac counts as
made. The notes searched for stamps are the day's folder, and those the index
finds stamped by the rule for one of the day's items, wherever they are: a
brief filed out of the Inbox is still made, by hand too, and only a deleted
one is gone. Neither grows with every brief ever written. A scheduled run never writes a
brief the log or a note records, even one deleted since; Run now writes
afresh one whose note is gone, as for #40. The period is read again after
Claude answers and before the write: a brief that synced in meanwhile means
nothing is written.

**One writer.** Nothing new: scheduled Claude runs are already held to the
Mac that runs the vault's automations (`gatedByFreshPull`, ADR-0035), as the
meeting notes are (ADR-0046). Run now is not gated, as for #40, so Run now
on the second Mac before git has synced the first Mac's briefs can write a
second copy, and the two can clash as add/add when they meet.

**A missed 07:00.** The scheduler's catch-up rule stands (a slot missed
while asleep or closed runs once, on the next tick). The brief briefs the
slot's day only while it is still that day (`briefDayOf`): a slot caught up
the next morning briefs nothing, and is logged as a run so its schedule
counts on from it.

**One failure, the rest still briefed.** Each meeting's ask is its own
`runClaudeStep`, and each is logged as its own entry. A provider failure, a
write the disk refuses, or a read of what it is handed that fails, on one is
a `failed` entry for that meeting, naming it; the others go on. Only a switch of vault, or the fresh-pull gates
shutting, ends the run early. Each entry is said once in Activity, as soon
as it is logged, so one made before a run is cut off is still said. At most
ten meetings are briefed in one run (one ask each); the rest are logged as
left, in an entry of their own, for Run now.

**The clock.** "Today" and 07:00 are the **plan zone's** wall clock: the
zone the vault's settings keep (`google_plan_zone`, ADR-0046's #587
amendment), which event notes are written on. James decided this on
2026-10-26: when he travels, the brief's day and its 07:00 slot follow the
primary calendar's zone, not the Mac's clock. Only this rule keeps it
(`keepsCalendarClock`); every other rule, and the Mac's own Today, keep the
Mac's. The scheduler counts the brief on that clock (`ruleClockOf`), and its
runs (`clockForRule`) log on it, so the brief's slot, its day
(`briefDayOf`) and its log entries are all on one clock and the catch-up
rule reads as before. The key is the slot's day on that clock, the same on
both Macs wherever they are, so a Mac far ahead or behind briefs each
calendar day once, at 07:00 there, and never skips one; the scheduler was
played out across zones a day apart and across both clock changes to show
it. When a zone is first kept mid-trip, a day the Mac's clock already
briefed is found recorded and not briefed again. While no zone is kept, it
is the Mac's clock, as before. Until the vault's settings have been read
when it opens, the brief is not counted at all (`waitsForPlanZone`): counted
on the Mac's clock meanwhile, a Mac far ahead of the calendar could brief
the calendar's tomorrow from yesterday's notes. A turn on opening is held
for the next tick, once the read lands; a settings note that cannot be read
counts as read, with no zone. No other rule waits. The Automations page and
`GET /v1/automations` show the brief's next run, and its log, on that
clock; where it is not the Mac's, the page says so (`28 Oct 2026, 07:00
Chicago time`) and the API row names it as `timeZone`, null for a rule on
the Mac's clock.

## Consequences

- A brief is a note: `/v1/notes`, `/v1/query` and the MCP note tools read it.
  No route or tool is added; the rule's `data` value appears in
  `GET /v1/automations` and `atlas_automations` as any other.
- Briefs accumulate under `Inbox/Briefs/`, one folder a day, until filed or
  archived.
- A rule's log holds up to 100 entries; a busy day writes one per meeting.
  The briefs' own stamps keep the record when old entries are dropped.

## Still open

- A rule's first mark, written when it is created, is on the Mac's clock:
  a brief created just after 07:00 calendar time, on a Mac whose own
  07:00 is still to come, briefs that day's meetings at once rather than
  from the next day. That is what the Mac's clock would have done anyway,
  and it is gone after the first run.
