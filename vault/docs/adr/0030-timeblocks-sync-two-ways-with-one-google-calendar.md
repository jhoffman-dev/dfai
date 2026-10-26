---
type: adr
id: ADR-0030
title: Timeblocks sync two ways with one dedicated Google calendar
status: proposed
date: 2026-10-07
---

# ADR-0030 — Timeblocks sync two ways with one dedicated Google calendar

## Context

James timeblocks: a block on the calendar that small tasks are pushed into,
or one big task placed on the calendar itself, and a task split across
several blocks. Blocks must show on his real Google Calendar as busy, so
colleagues see them. Atlas reads ICS today (Phase 12) and writes nothing to
any calendar.

## Decision

**A `block` is a note** (`type: block`, `start`, `end`, `tasks` relation
many). It syncs to **one dedicated Google calendar** ("Atlas blocks"), made
by Atlas, as **busy** events whose title is the block's title. Atlas never
writes to any other calendar and never reads event bodies it did not write.

**OAuth lives in the host.** A desktop OAuth flow (loopback redirect, PKCE)
with the `calendar.events` scope on that calendar only where possible; the
refresh token is a Keychain secret (ADR-0017) bound to
`https://www.googleapis.com`. The webview never sees it.

**Identity is the event id, stored on the block** (`gcal_event_id`,
`gcal_etag`). Reconcile runs on a schedule and after each block write:
Atlas-side changes push; Google-side time changes pull into the block; a
change on both sides since the last sync keeps Google's time and records the
conflict in Activity. An event deleted in Google marks the block
`gcal_missing: true` (ADR-0012 style), never deletes the note. Sync is
incremental (`syncToken`), so a reconcile is one cheap request.

## Consequences

- One more secret and one more outbound site; the host's binding rules apply.
- Works with the Mac awake only; blocks made on another Mac sync from the
  automations Mac.
- Google Workspace admin policy may forbid a third-party OAuth client on a
  work account — an open question to check before building.

## As built (P31-01, 2026-10-08)

The block model and its scheduling rules, which sync builds on:

- **The Block type** has `start` and `end` (dates with a time, both
  required), `tasks` (a relation to tasks, many) and `gcal_event_id` and
  `gcal_etag`. It is built in — it cannot be deleted — and is written into a
  vault once its tasks follow GTD (its Task type's status is the eight), as it
  opens or as soon as the move to GTD lands, never over one that is there,
  and said in Activity. A vault on statuses of its own is left as it is:
  writing a type into every vault with tasks changed what small vaults show
  first (the dashboard sheet's first type) for no use. Undoing the move to GTD
  leaves the Block type, which the move did not write. A write is never
  cancelled by the types being read again: what it did is said once, a
  failure only when every write for the vault has settled and none landed,
  and a vault is tried once until it is opened again. `gcal_missing` comes
  with sync (P31-04).
- **A one-task block gives that task its whole length.** A block of several
  is a container: when its tasks need at least the whole block it is shared
  in proportion to what each has left of its estimate; when they need less,
  each gets what it has left and the rest is shared equally among the tasks
  with no estimate, or stays free. "What it has left" is its estimate, or
  nothing once finished — not its estimate less time scheduled elsewhere,
  which would make one block's shares depend on every other block. Shares are
  whole minutes that add up to the block, the odd minute to the largest
  remainder, then the earliest listed — worked in exact integers, a
  remainder being `length × weight mod sum`, so equal remainders are equal
  however large the estimates. An estimate longer than a hundred years is
  read as none.
- **Blocks count on their own.** A task in two blocks that overlap is given
  both, and so reads as over-scheduled, rather than merged into less than was
  set aside. Past blocks count as well as future ones: no rule reads the
  clock.
- **A block is its wall-clock length as written**, as the calendar draws it:
  a block across midnight runs into the next day, and one across a
  daylight-saving change is as long as the clock says (01:30–03:30 is two
  hours on the night the clocks go forward). Nothing converts between zones,
  so the answer is the same on every Mac. A block without a time at both ends,
  or ending no later than it starts, gives nothing; it is not refused, since
  sync may pull such an event from Google.
- **For P31-04: blocks hold local wall-clock times, with no offset.** `start`
  and `end` are written `2026-10-12T09:00`, read as the time where the person
  is. A zone or offset written after the time (`…T09:00Z`, `…T09:00+02:00`) is
  currently ignored, as the calendar ignores it (`readEventTime`), so it is
  read as the same clock time. Sync must therefore convert Google's RFC 3339
  times to local wall-clock before writing a block, and convert the block's
  local times to RFC 3339 with the Mac's zone before pushing — never copy an
  offset into the note.
- **A task shows estimate, scheduled and done** under its properties, and
  how far it is over. Done comes from the status the Task type is ticked with
  (`archive` for GTD): all of the estimate once finished, none before.
  **Follow-up:** checklist progress (P30-03, #22, built on a sibling branch)
  is not read yet. Once it lands, done for an open task should be its
  estimate × the share of its checklist ticked, and a container's "what it
  has left" should follow. An estimate is minutes; `2h` and
  `1h30m` are read too, for a vault that kept a text estimate, but a day or a
  week is not — a day's working minutes are the person's to say.
- **No write rule is added.** Scheduling is read from blocks, never stored on
  a task, so the write chokepoints (ADR-0029) are unchanged.
- **Read from the index**: the tasks asked about, and every block linking any
  of them with all its tasks. Blocks are read a page at a time in order of
  their paths; a page the row cap cut short drops its last, possibly partial,
  block and the next page starts after the last whole one. Only a single
  block linking more tasks than the cap returns is refused, never answered
  short. The API reads the same with `POST /v1/query` and
  `schedule: true` (ADR-0016's P31-01 amendment).

## As built (P31-02, 2026-10-10)

Planning the day by dragging tasks onto the calendar:

- **The tray stands beside a calendar of blocks** — a view of the Block type
  drawn as a week, three days or a day — and lists the next actions as the
  Next actions view reads them (deferred ones stay out until their day), the
  ones with no time set aside yet first. A new calendar view of blocks spans
  each from its `start` to its `end`; switching an existing view to Calendar
  does not, since a view edit cannot set an end.
- **Let go on empty time, a task becomes a block** from the quarter hour the
  pointer is in, as long as what the task still needs — its estimate less
  what blocks give it and what is done — at most a day, and half an hour when
  it has no estimate or needs nothing more. Dragging the same task again makes
  another block for what is left: that is splitting. A drop made before the
  tray has read the last one counts it, so it gets what that one left. The
  block is a new note made through `createNote`, from the Block type's
  template when there is one, at the top of the vault, named "<task> block"
  (numbered when taken, the task's name cut by whole characters to fit a file
  name's 255 bytes), with `start` and `end` as wall-clock times with no
  offset. The target is what is under the pointer on this calendar's own
  clock, the pointer followed from its own moves — a scroll of the tray under
  a held task is not travel.
- **Let go on a block, the task joins its `tasks`**, linked after the others,
  which are written back as they were; a block already linking it, anywhere
  in an item as the index reads relations, is left alone, and so is a note
  that is not a block. The write goes through a pane holding the block, else
  `setNoteProperties` — the task-rule chokepoints — never to the file
  directly. A block drawn all day takes a task as a timed one does.
- **The keyboard has the same path**: Enter (or a click) on a task chooses it,
  focus goes to today's first hour, and Enter on an hour or a block places it;
  Escape lets it go, and so does the tray no longer listing it. The pointer
  drag takes no keys, since a held task has no step on the clock to make.
- **The last drop can be undone.** A block it made goes to the Trash while it
  holds exactly what the drop wrote and no pane holds typing in it not yet
  saved; otherwise it is left and the reason said. A task it linked is
  unlinked, the block's other links kept. The undo is kept for the vault the
  drop was made in only, is the last-started drop's when drops settle out of
  order, and runs once at a time.
- **A drag near the clock's edge does not scroll it**: the tray is not inside
  the clock's scroller. Scroll to the part of the day first.

## As built (P31-03, 2026-10-10)

The connection is built; syncing blocks (P31-04) is not. The host side is
`apps/desktop/src-tauri/src/google.rs` and `google/`; the rules are in
`packages/domain/src/google-calendar`; Settings → Google Calendar is the
card. Where the build went past or around the text above:

- **The flow.** RFC 8252 with PKCE (RFC 7636): a listener on `127.0.0.1`
  at a port the system picks, `S256` from a 32-byte verifier, and a 16-byte
  `state` compared in constant time. Only a redirect to `/` carrying this
  sign-in's `state` is acted on; any other request is answered with fixed
  text and ignored, so another program on the Mac can neither end the
  sign-in nor slip its own code into it. A redirect carrying an error and a
  code is a refusal. One sign-in waits at a time; it ends after five
  minutes or on Cancel. `access_type=offline&prompt=consent` is sent, or
  connecting again after a disconnect would bring back no refresh token.
- **The scope is `calendar.app.created`, not `calendar.events`.**
  `calendar.events` reaches every calendar on the account and cannot be
  narrowed to one. `calendar.app.created` lets Atlas make secondary
  calendars and change events on those alone — the "on that calendar only"
  the decision asks for — and Google lists it as non-sensitive. A consent
  screen lets the person untick a scope and still allow; a token without
  it is refused, revoked and not kept. Reading meetings for P31-05 will
  need a read scope added then, by incremental consent.
- **Where the tokens live, and where they may go.** The refresh token, with
  the client it was issued to and the scopes granted, is one Keychain item
  through the `SecretStore` every secret uses, scoped per vault as ADR-0017
  scopes secrets, at `<vault>:oauth/google`. It is deliberately not a
  named secret: a named secret can be filled into a source's request and
  rebound by the person in Settings → Secrets, and this token's
  destinations are the protocol's, not the person's. So the host pins them,
  the way `model_http` pins the Messages API: the refresh token goes only
  to `https://oauth2.googleapis.com` (`/token` to refresh, `/revoke` to
  revoke) — not `www.googleapis.com` as the decision says, because that is
  where Google's token endpoint is — and the access token, held in the
  host's memory only, goes only to `https://www.googleapis.com` under
  `/calendar/v3/`, checked after the path is parsed so `..` cannot climb
  out. No redirect is followed. The access token is renewed a minute
  before it expires, and a 401 renews it once.
- **The webview never sees a token.** It sees whether a sign-in is kept,
  its client and scopes, and a Calendar API answer with the access token
  struck from it. The PKCE verifier, the code, both tokens and any client
  secret stay in the host. A Rust test serializes every answer and failure
  the commands can hand back, with the API echoing its `Authorization`
  header, and finds none of them
  (`no_answer_or_failure_handed_to_the_webview_carries_a_token`); the IPC
  contract test pins the five Google commands.
- **Where the line is (ADR-0005).** The host holds the protocol and where a
  token may go: the endpoints, PKCE, `state`, the listener, the Keychain,
  and the token's lifetime. TypeScript decides the client, the scope, which
  Calendar calls to make and what their answers mean, which calendar holds
  blocks (one the person owns, never their main one), when to offer to make
  "Atlas blocks", and what each failure tells the person. The host reports
  a failure as a kind and Google's OAuth code; `explainGoogleFailure`
  words it.
- **The client ID is configuration.** Typed in Settings → Google Calendar
  and kept in the vault's settings (`google_client_id`), beside the chosen
  calendar (`google_calendar`), so both Macs use the same calendar; each
  Mac signs in for itself. No client ID is in this repository: James
  creates one in his own Google Cloud project (a Desktop app client, with
  the Calendar API enabled and the scope on its consent screen).
- **A client secret is optional, and never committed.** The task assumed a
  Desktop client with PKCE needs none. Google's documentation for installed
  apps says otherwise for the "Desktop app" client type: its token request
  lists `client_secret` as required, omitting it only for Android, iOS and
  Chrome-app clients, and says an installed app's secret is not treated as
  confidential. This could not be checked against Google here (the build
  talks only to a local fake), so Settings has a masked field for it, sent
  only when typed. It is kept in the Keychain item with the refresh token,
  never in the vault or the repo, and reused when connecting again with the
  same client. If Google accepts PKCE alone for the client, leave it empty.
- **Disconnect revokes and forgets.** RFC 7009 revocation of the refresh
  token, which ends its access tokens too; Google answering `invalid_token`
  (already revoked) counts as revoked. The Keychain item is removed even
  when Google cannot be told, and Settings then says to remove Atlas from
  the Google Account's third-party access.
- **Each vault's sign-in is serialised by a generation** (after review and
  an adversarial pass). Connecting and disconnecting move it on; a refresh
  saves its rotated refresh token and holds its access token only if the
  generation it started from is still current, checked and written under
  one lock. So a refresh still out when the person disconnects, or connects
  again, keeps nothing: the removed sign-in does not come back, a newer one
  is not overwritten, and no access token outlives a disconnect. A call
  whose refresh was discarded starts again from what is kept now. An
  `expires_in` past the clock's range is held for a day at most rather
  than panicking the command.
- **The browser's tab hears the truth.** The loopback answers the redirect
  only once the code is traded, the scope checked and the grant kept, so it
  says connected only when it is. A failed accept (out of descriptors, a
  reset) is waited out rather than ending the sign-in, and past 16
  connections no more are taken until one ends: a newcomer waits in the
  kernel's queue rather than being closed, since it may be the browser.
- **A sign-in other vaults may share is not revoked.** Google may revoke a
  whole grant — every token one person gave one client — rather than the
  single token it is sent; this is not verified here. Atlas asks for no
  identity scope, so it cannot tell which account a sign-in is for. When
  another vault on this Mac keeps a sign-in for the same client ID,
  disconnecting forgets this vault's and does not revoke it, and Settings
  says so; disconnecting the last one revokes.
- **An expired or revoked sign-in** comes back from the token endpoint as
  `invalid_grant`; Settings says to connect again, and that a sign-in which
  lapses every week means the Cloud project's consent screen is in Testing,
  where Google ends refresh tokens after seven days.
- **The local API and MCP expose status only**: whether Google Calendar is
  connected, never a token and no calendar call.
- **Still open — the spike the card asks for.** Whether James's Workspace
  allows a third-party client; whether this client needs its secret; and
  that `calendar.app.created` lists the calendars Atlas made through
  `calendarList`. Each is a configuration change or a one-line scope change
  if it turns out otherwise.

## As built (P31-05, 2026-10-24)

Reading meetings added the read scope by incremental consent, as the P31-03
note said it would: `calendar.events.readonly`, asked for only once the
person turns meetings on. The scope list became one row per use
(`GOOGLE_SCOPES_BY_USE`). The host is unchanged apart from a timeout tests
can shorten. ADR-0046 has the decision, and what P31-04 adds on top of it.

## As built (P31-04, 2026-10-25)

Two-way sync of blocks with the one calendar they go to (#30):

- **The scope is `calendar.app.created`, the one connect already asks for.**
  It reaches only calendars DFAI made, so "never write to the main calendar
  or any other" is held by Google, not only by this code. `calendar.events`
  cannot be narrowed to one calendar: it reaches every calendar the person
  can write, which is the reach this ADR set out to avoid. The separate
  allowance is the vault switch **Sync blocks with Google Calendar**
  (`google_blocks: true`), off until the person turns it on: connecting
  writes nothing to Google. A sign-in that lacks the scope (unticked on the
  consent screen) is asked for it by incremental consent when the switch is
  turned on (`allowGoogleBlocks`, `scopesWith(…, 'blocks')`). Every sync is
  gated on `grantsUse(scopes, 'blocks')`, and a 403 for want of a scope
  stops the run and waits until the grant changes, as meetings do. A
  calendar the person made themselves is not reached by this scope; if
  James wants one, it is a `calendar.events.owned` row in
  `GOOGLE_SCOPES_BY_USE`, as ADR-0046 says.
- **One writer.** Only the Mac that runs the vault's automations (U-29)
  syncs blocks; any other Mac never calls Google for them. Every 15 minutes
  while the vault is open, once its index is ready, and on **Sync blocks
  now**. A vault without the switch, a client ID and a calendar asks the
  host nothing.
- **The rules are one pure function**, `reconcileBlocks`, in the domain. A
  block's event is found by `gcal_event_id`. **What both sides last agreed
  is on the block itself**, in three owned keys written byte-preserving
  with the others: `gcal_synced_title`, `gcal_synced_start` and
  `gcal_synced_end`. A first version kept it in this Mac's `localStorage`;
  a new automations Mac, cleared site data or a failed write of the
  version then had no base and quietly let Google undo James's edit, and a
  Mac switched back to read an old one as a conflict. Now every Mac
  compares with the same record. Google's times are compared with it, never
  only its version (`gcal_etag`), since Google gives an event a new version
  for a description, a colour or a reminder as well as a move:
  - Google's times are the agreed ones (whatever else changed there) and
    the block's differ → patch the event with the block's title and times.
  - Google's times differ from the agreed ones and the block's do not →
    pull Google's times into `start` and `end`.
  - Both differ from the agreed ones, apart → Google's time is kept and
    Activity says so for that block. Both moved to the same time → agreed;
    only the record is written. A block with no record (one synced before
    the keys existed) whose times differ from Google's is treated as both
    changed: Google's time is kept, and said.
  - Both on the agreed times with a new version → only `gcal_etag` is
    written. A version Google gives as null is never written: values
    decide, so an event listed without one does not rewrite the block on
    every sync.
  - Titles go one way. A block's title is its note's name, which a sync
    never renames; an event renamed in Google is put back to the block's
    name — in the same run as a pull, when it was moved and renamed, so
    title and time converge.
  - Cancelled in Google, or missing from a full listing → `gcal_missing:
true`. The note is never deleted, and a missing block is never pushed.
    If the event comes back, the mark comes off and its times are pulled.
- **A push is recognised as DFAI's own.** Before an insert or patch is
  sent, the values sent are written onto the block as the agreed record,
  and `gcal_etag` is cleared; the version is written when Google answers.
  If the push lands but that last write fails (James saved the block in
  between, so its modification time moved), the next sync finds Google on
  the agreed times — DFAI's own push — and pushes his newer edit, rather
  than read it as a Google move and roll him back. If the push never
  lands, the block has no version, so the next sync sends it again
  (insert, then patch on 409) instead of taking the record as agreed.
- **Copies keep one event with one note.** Two or more notes carrying one
  `gcal_event_id` (a Finder "… copy.md", a template, a copy into this
  week's folder) are found across every note, of any day, by a query on
  the id, not only within the two-week window. The event records the note
  it was last written for, as a private extended property (`dfai_note`,
  set on every insert and patch; a moved note's event is patched to name
  it). When the listing did not give the event, it is read with
  `events.get` first. The original is the note the event names; else the
  one on the event's times; else the one unchanged since it was agreed;
  else the first by path. Every other copy is a new block: its owned keys
  are cleared, and one with times from the window on gets its own event;
  an older one stays off Google. A copy never patches the original's event
  and its times are never pulled into another note. Activity says "is a
  copy of another block, so it was made a block of its own".
- **No duplicate events, even with two writers.** A new block's event id
  is drawn from the blocks calendar's id (the same on every Mac, from the
  vault's settings, and one per vault) and the note's path at its first
  push: `dfai` and two 64-bit digests, in Google's base32hex alphabet
  (`blockEventId`). It is written onto the block, with the agreed record,
  before the insert. Two Macs that both act as writer for one tick (git has
  not carried the first one's id) send the same id; Google answers the
  second with 409 and it patches the one event. An insert retried after a
  failure uses the same id. An id another note already carries (the block
  was renamed since its first push and a new note took its old path), or
  one Google holds as deleted (409, then 410 on the patch), moves on to the
  next attempt, up to four.
- **Ids are checked before any URL is built.** An event id must be
  base32hex, 5 to 1024 long; a calendar id must be `name@domain`. Anything
  else — `..`, a `/`, `primary` — is refused before the host is called (it
  resolves dot segments, so `..` would reach another resource). A block
  whose `gcal_event_id` is not one Google could have given is treated as
  having none.
- **Which zone a block's wall clock means: the plan zone of ADR-0046.**
  Blocks are written and read on the same zone as meetings: the primary
  calendar's `timeZone` (read with `events.list` on `primary`, one event,
  `fields=timeZone`), else the Mac's when the sign-in may not read events
  (blocks without meetings) or Google names none. A block at 09:00 and a
  meeting at 09:00 on the Today list are at one 09:00, and two Macs in two
  zones place a block the same. The event is written as `{ dateTime:
"2026-10-26T09:00:00", timeZone }` with that zone, so Google places it.
  The blocks calendar's own zone plays no part: one made through the API
  without a zone is on UTC, and an earlier version wrote blocks hours off
  on it. DFAI now makes "DFAI blocks" with the Mac's zone. This replaces
  both the P31-01 note above ("with the Mac's zone") and the first P31-04
  rule ("the calendar's own zone").
- **Listing and tokens.** The calendar is listed whole (no time range,
  `showDeleted=true`), then by `syncToken`; 410 lists it whole again. A page
  whose `nextPageToken` is anything but a string is an error, never the end
  of the listing (read as the end, every block on a later page would be
  marked missing). The token is the only thing kept per vault on this Mac
  (`localStorage`, `atlas.block-sync:`), a cache that starts over when
  another calendar is chosen and costs one full listing when lost. It moves
  on only once every write of the run landed, so a failed run reads the
  same changes again; writing again what was written changes nothing.
  Blocks starting from two weeks ago are pushed; older ones only follow
  Google if their event changes.
- **Per item.** Each block's writes are their own: one that fails is named
  in Activity (with the note as its subject) and the others still sync. A
  warning is said once until it changes. **Stop syncing blocks** takes
  effect at once on this Mac: `wanted()` is asked before every call to
  Google and every write — between writing a new id and sending its insert
  too — so nothing more is asked or written, and no record is kept.
- **Writes are byte-preserving** (ADR-0003): only `start` and `end` on a
  pull, and the owned keys `gcal_event_id`, `gcal_etag`, `gcal_calendar`,
  `gcal_missing` and `gcal_synced_title`/`_start`/`_end`, through
  `updateFrontmatter`, with the file's modification time checked. The body
  and every other key are never touched, and no note is deleted or
  renamed. The Block type written into new vaults lists the owned keys.
- **Calls.** `events.list`, `events.get`, `events.insert` and
  `events.patch` on the blocks calendar only, and one read of the primary
  calendar's zone, built in TypeScript (`tauriBlockCalendar`) and sent
  through the existing `google_calendar_request` passthrough. No delete is
  ever made: a block deleted in DFAI leaves its event. The host is
  unchanged; a Rust test now proves an insert and a patch reach Google as
  built and a 401 is renewed once.
- **API and MCP.** No new route. A block's sync state is in its properties
  on `GET /v1/notes/{path}` and `/v1/query`, as every property is; nothing
  through the API calls Google.
- **Still open.** Writes carry no `If-Match`: the passthrough sends no
  extra headers, so a change made in Google between this run's listing and
  its patch is overwritten by the patch. The next listing shows the
  result, and the window is seconds. An event made in Google on the blocks
  calendar, with no block, is left alone rather than made into a note. A
  write Google answers with no version leaves the block without one, so
  each later sync sends it again (insert, 409, patch) until one comes with a
  version; Google always gives one, so this is a guard, not a path. Two
  vaults pointed at one blocks calendar would draw one id for one path;
  each vault makes its own calendar, so they do not. Block sync and
  meetings sync still run two copies of one loop in the desktop app
  (issue #585).
