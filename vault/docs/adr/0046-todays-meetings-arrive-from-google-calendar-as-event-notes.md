---
type: adr
id: ADR-0046
title: Today's meetings arrive from Google Calendar as event notes
status: proposed
date: 2026-10-24
---

# ADR-0046 — Today's meetings arrive from Google Calendar as event notes

## Context

The morning brief (#39) needs to know who James meets today, and the Today
page and the calendar should show it. The meetings are on his work Google
Calendar. His company's Workspace lets a third-party OAuth client read and
write calendars, and he will make the client in the company's own Google
Cloud project. That makes it an internal app, with no Google verification
to pass.

The connection already exists. P31-03 (#29, ADR-0030 "As built") built a
desktop OAuth flow in the host: a loopback redirect, PKCE, the refresh token
in the Keychain and the access token in memory. It also built one generic,
pinned command for Calendar calls, `google_calendar_request`. The sign-in
asks only for `calendar.app.created`, which cannot read James's own
calendar. ADR-0030 left reading meetings to this card: "a read scope added
then, by incremental consent".

ADR-0012 says external data arrives as notes. A source's refresh writes
markdown, marks a record that has gone, and never deletes. That holds here
too, with one difference covered below: a calendar is read a window at a
time and then by what changed. The ICS refresh, by contrast, reads the whole
feed every time.

## Decision

**Meetings are event notes.** A meetings sync writes one note per meeting,
`type: event`, into `Calendar/`, named `<day> <title>`. Each note carries
these properties:

- `title`, `date` and `ends`, on the wall clock. ADR-0030 keeps times with no
  offset (`2026-10-24T09:00`); an all-day event is just its days.
- `attendees`: everyone's address except the person's own and the rooms'.
- `people` and `companies`, linked by P29-04's `matchAttendees`. Only sure
  matches by address or name are linked. An unknown attendee stays an
  address and is never guessed.
- `meeting`: the meeting note a notetaker wrote, when exactly one is on that
  day, under that title, starting within 20 minutes.
- `gcal_event_id`, `gcal_calendar`, `gcal_recurring_event_id`, and
  `gcal_response` (the person's own answer).

The body is never written. It is the person's, for prep. Every view,
backlink, Person page and query already works on these notes, because they
are notes.

**Nothing is ever deleted.** When Google says an event was cancelled, its
note gets `gcal_missing: true`. If the event comes back, the mark comes off.
That is ADR-0012's rule, with ADR-0030's `gcal_` name for everything that
comes from Google. A confirmed event whose time cannot be read is left
alone, never taken for gone.

**Today's meetings are read from the notes, not from Google.**
`readDayMeetings(day)` is one index query, so it answers offline and on a
Mac that is not signed in. It lists timed event notes on the day that are
neither cancelled nor declined, earliest first, each with its people,
companies and meeting note. All-day events are left out: they are on the
calendar, but there is nothing to prepare. The Today page draws this above
the tasks, and the morning brief (#39) reads it per meeting.

### Auth flow: unchanged, one more consent

- The flow stays P31-03's. It runs RFC 8252 with PKCE (S256): a listener on
  `127.0.0.1` at a port the system picks, a constant-time `state` check,
  `access_type=offline&prompt=consent`, and `include_granted_scopes=true`.
  The client ID is typed in Settings → Google Calendar and kept in the
  vault's settings. A client secret, if Google issued one with the client,
  is typed into a masked field and kept only in the Keychain.
- Turning meetings on is one more consent screen: **Allow reading meetings**.
  It asks for what was granted plus the read scope, with the same client.
  `scopesWith(granted, 'meetings')` builds the list and is null when nothing
  is missing, so no consent screen is shown for nothing.
- The Rust side is unchanged except for one thing: a call's timeout is now
  part of `Endpoints`, so a test can shorten it. There is no new command.
  TypeScript builds the `events.list` call, and the host sends it to the
  pinned origin under `/calendar/v3/` with the token, then strikes the token
  from the answer.

### Token storage: unchanged (ADR-0017, ADR-0030)

There is one Keychain item per vault, `<vault>:oauth/google`. It holds the
refresh token, the client it was issued to, the scopes granted, and any
client secret. The access token is held in the host's memory only. The
webview never sees either token. The Rust contract test that serialises
every answer and failure now covers an events page that echoes its
`Authorization` header.

### Scopes: one list per use, the least each needs

`GOOGLE_SCOPES_BY_USE` (domain) names them:

| Use        | Scope                      | For                                       |
| ---------- | -------------------------- | ----------------------------------------- |
| `blocks`   | `calendar.app.created`     | DFAI's own calendar for blocks (ADR-0030) |
| `meetings` | `calendar.events.readonly` | reading events, changing none (this ADR)  |
| `export`   | `drive.file`               | Drive files DFAI made (#501)              |

A new use is a new row. `scopesWith` and `grantsUse` are the only way a scope
list grows. The export's old `scopesWithDrive` is now
`scopesWith(…, 'export')`, so there is one way to do it. A permission the
person unticks on the consent screen is refused and not kept, as before,
and the meetings case is worded as such.

### The sync model

- **Which calendars.** The vault setting `google_meeting_calendars` names
  them; unset, it is the person's main calendar (`primary`). The blocks
  calendar (`google_calendar`) is never read for meetings. The vault switch
  `google_meetings: true` turns meetings on for the vault, so both Macs read
  the same calendars. Each Mac signs in and consents for itself.
- **When.** The sync runs once the index is ready, every 15 minutes while the
  vault is open, and on **Read meetings now**. One runs at a time per
  window. A vault without both the switch and a client ID asks the host
  nothing, which is how the work budgets stay where they are.
- **The window.** The sync reads yesterday through six days ahead, on the
  person's wall clock. Yesterday is in, so a notetaker's write-up that
  arrives the next morning is still matched. The window's bounds are the
  instants those days begin in the Mac's zone (`startOfDayIn`). That holds
  across a DST change and on a day whose midnight the clocks skip.
  Recurring events are read as instances (`singleEvents=true`), each with
  its own note. Cancelled ones are listed too (`showDeleted=true`).
- **Full, then incremental.** The first listing of a window is in full, with
  `timeMin`/`timeMax`. Google gives a `nextSyncToken` on its last page, and
  each later sync asks only what changed since that token. Google does not
  allow a range together with a token, and every other parameter is the
  same both ways, as Google requires. A token is kept per calendar on this
  Mac (`localStorage`, as Granola's watermark is, ADR-0034), with the
  window's first day. A new day means a new window, and so a full listing.
- **410 Gone means a full resync.** A token Google no longer honours answers
  410, and the window is listed in full again. On a full listing, a note in
  the window whose event is no longer listed is marked missing: it was
  deleted while DFAI was not following the calendar's changes.
- **Every page or nothing.** A listing is read to its last page before it is
  used, because a listing cut short would read as deleted events. Past 40
  pages it fails as malformed.
- **Idempotent.** A sync writes only the properties whose value would change.
  A token is kept only once every write has landed, so a sync that stops
  part way is read again from where the last whole one left off. Writing
  again what it already wrote changes nothing. Notes the last sync made that
  the index has not reached yet are found by name in `Calendar/`, so no
  second note is made. If a race between two Macs does make two, the first
  by path is the one written to.
- **Invitations on two calendars** are one meeting: the first calendar's copy
  wins, unless it is cancelled there and not on the other.

### Offline and failing

A sync's failure is a report, never a rejection. Offline, the notes already
in the vault stay as they are, Today and the brief still read them, and the
next sync catches up. Settings shows what stopped the last sync and how to
fix it (`explainGoogleFailure`). Activity hears what a sync wrote, and a
problem once until it changes, not every quarter hour while offline. The
host already renews the access token on a 401, once. A refresh token Google
no longer honours is `invalid_grant`, and the fix is to connect again.
403, 429 and 5xx come back as `api_refused` with the status. The next sync
in 15 minutes is the retry, so nothing hammers Google.

### What #30 adds

Two-way sync of blocks needs no new scope. `calendar.app.created` already
lets DFAI change events on the calendar it made. #30 adds:

- a pure `reconcileBlocks` beside `planEventNotes`;
- calls on the same `google_calendar_request` (`events.insert`, `patch`,
  `delete` on the blocks calendar only);
- the same per-calendar sync-token record, reused for the blocks calendar;
- `gcal_event_id` and `gcal_etag` on the block, and `gcal_missing` when
  Google deletes the event.

This sync already leaves the blocks calendar alone, so a block never becomes
a meeting. If James ever wants blocks on a calendar he made himself, not one
DFAI made, that is a new `GOOGLE_SCOPES_BY_USE` row
(`calendar.events.owned`), asked for by the same incremental consent.

## Consequences

- One more permission, read-only, on one more consent screen, and only for
  the vaults that turn meetings on.
- Event notes accumulate in `Calendar/`, one per meeting, kept forever like
  any note. Archiving or moving them is the person's; a moved note is still
  found by its id.
- A note's file name keeps the day and title it was made with. A moved or
  renamed meeting changes its properties, not its file.
- The local API and MCP need nothing new: event notes are notes, readable
  through `/v1/notes`, `/v1/query` and the existing MCP tools. Whether a
  vault is connected stays on `/v1/status`, and no token or Calendar call
  is exposed.

## Still open

- Whether Google gives a `nextSyncToken` for a listing restricted by
  `timeMin`/`timeMax`. Its documentation implies so, but this could not be
  checked against Google here, since the build talks only to local fakes.
  If it does not, every sync is a full listing of the window, which is
  still correct, only a little more traffic.
- Whether James's Desktop client needs its secret (ADR-0030's open
  question). The Settings field is there either way.
- Choosing extra calendars from Settings. Today they are named in the vault
  setting by hand.
- Unknown attendees as `person` proposals. P29-04 proposes them for meeting
  notes; event notes leave them as addresses for now.
