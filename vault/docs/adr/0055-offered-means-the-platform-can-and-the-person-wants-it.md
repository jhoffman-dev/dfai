---
type: adr
id: ADR-0055
title: Offered means the platform can, and the person wants it
status: proposed
date: 2026-11-17
---

# Offered means the platform can, and the person wants it

Amends ADR-0051.

## Context

ADR-0051 made one gate for what the screen offers: each entry point names the
platform capabilities it needs (`NEEDS` in
`packages/application/src/platform/entry-points.ts`), and the sidebar rows,
palette commands, shortcuts, Settings sections, presets and runners read
`offered.*` rather than ask which platform they are on.

James asked (#901) for a way to switch key features off, as Obsidian does: "the
ebook functionality isn't needed for everyone and if it's turned off, it
shouldn't show in the view." Hiding a feature is the same question the gate
already answers — whether an entry point is on screen — asked of the person
rather than the platform. A second set of checks beside it would drift from it.

## Decision

1. **Offered means the platform can, and the person wants it.**
   `entryPointsOffered(capabilities, featuresOn)` gives an entry point when every
   capability it needs is there _and_ the feature it belongs to is on. The
   features are a registry in the domain (`packages/domain/src/features`):
   each has an id, a label, a one-line summary, and the features it
   `requires`; one is off whenever something it requires is. Kindle requires
   Reading. `FEATURE_OF`,
   beside `NEEDS`, names the feature of every entry point, or null for one no
   switch hides: a new entry point cannot leave it unsaid. `PAGE_ENTRY` names
   the entry point a page is drawn under, so a place reaches its feature
   through the one table.
   Everything else keeps reading `offered.*`, as before; nothing grows an
   `if` of its own.

2. **The off list, per vault.** `featuresOff: [ids]` in `.atlas/settings.md`.
   Storing what is off means an absent key is everything on, so no existing
   vault changes, and a feature added later arrives on. An id the app does not
   know is ignored when read, and kept when written: a switch starts from the
   list as the file holds it and adds or takes out its own id alone, so what a
   newer version switched off on another Mac survives. Anything that is not a
   list switches nothing off; it is the one case where a switch rewrites the
   key whole, as a list holding only what was just chosen. Every entry a
   switch does not change is written back as it was: ids from a newer
   version, and entries that are not ids at all. **`requires` decides what is
   on, never what is written:** the list holds only what the person switched
   off. Switching Reading off writes `reading` alone; Kindle is then off
   because Reading is, its row says "Needs Reading." and its switch is held
   (shown off, not flippable) until Reading is on again, when Kindle is back
   as the list left it. It is
   read in the window's one read of the settings note and settles in the same
   commit as the sidebar's order, and a switch is one byte-preserving write of
   that key through the vault's one settings writer. Per vault rather than per
   machine, so both Macs and the web agree.

3. **One object per off list.** The shell decides the platform's `offered`
   once as it mounts, and the window derives the person's from it
   (`offeredFor`): the platform's own object while nothing is off, otherwise
   one frozen object for each off list's content, kept for the window's life.
   What is memoised on `offered` (the Settings sections' lists, the export
   formats, the presets) is made again only when the off list changes, and
   the runners that read it through a ref (the automations runner) do not
   start over.

4. **What is gated.** Every way into a switched-off feature's view: its
   sidebar rows, its palette commands, its pages, its Settings sections, its
   shortcuts and its background work, and its code is left out of the
   preloads until it is on. A place that belongs to an off feature — a kept
   tab, a link, a highlight's jump, a file clicked in Pages, a search result —
   reaches `containerFor` like any other, which draws a notice in its place:
   "Reading is turned off", with "Turn on in Settings", which opens Settings
   at Features. A page whose entry point the platform itself does not offer
   (Ask on the web) gets no notice, as no switch could bring it: it is drawn
   as it was before the switches. Until the vault's settings have answered, a tab on a
   feature's page shows its empty frame rather than the page, so a kept tab
   on a PDF never loads the reader of a Reading that turns out to be off; an
   overlay a feature's command opened (Add PDF…) closes when its entry point
   stops being offered. Slice 1 gates Reading (PDF and EPUB, the Library, All
   highlights) under three new entry points, `libraryPages`, `documentReader`
   and `addDocuments`. Slice 2 adds four switches:
   - **Kindle** (requires Reading): `kindleSettings`, `kindleCommands` and a
     new `kindleSync`: the sync as the index is ready, its four-hour timer,
     Sync now and Connect stop while it is off. A sync already running
     when it is switched off finishes (it writes whole notes), but says
     nothing: its toast, and any toast up, are put away, not hidden.
     Switched on, it runs the usual automatic sync at once. With Kindle off,
     Disconnect is out of reach and the stored Kindle sign-in stays; switch
     Kindle on to disconnect.
   - **Ask and Claude chat**: `claudeChat`: the Ask page (`PAGE_ENTRY`), the
     sidebar's Ask, ⌘J, ⇧⌘J, the page bar's Claude and the aside's Claude tab.
     Its page's code (`askScreen`) is a feature preload. Off, the chat does
     no work for a kept Ask tab or a remembered Claude tab: no "is Claude
     reachable" check, no window context sent, and a turn under way is
     stopped as Stop stops it; the conversation and the draft are kept.
   - **Graph**: a new `graphPage`: the page (`PAGE_ENTRY`), the sidebar's
     Graph and a note's Show in graph; its chunk is a feature preload.
   - **Slack capture**: `slackSettings` and `slackLinkOffer`: Settings →
     Slack, and the paste listener, which is taken off the page while it is
     off (not left to answer nothing). An offer up at the time is
     dismissed, and an answer still on its way dropped, so switching it on
     brings none back. Its token stays in the Keychain.

   Slice 3 adds the last two, which move and write files:
   - **Automations**: `automationsPage` (the page, `PAGE_ENTRY`, and its
     sidebar row; its chunk is a feature preload), `claudeAutomations` (the
     editor's Ask Claude, the presets with a Claude step and the meeting
     set-up offered on the Inbox, which writes a rule) and a new
     `automationsRunner`. Run now, dry runs and the presets live on the
     page, so they go with it; no ⌘K command, shortcut or Settings section
     belongs to the rules. **Off, no rule is set off by anything**: not the
     clock, not opening the vault, not a note's news. The runner is not
     unmounted: it is handed `scheduled: false`, as on a Mac that does not
     run the vault's automations (U-29), so the prompts are not refreshed,
     no rule is taken in, news a note set off is let go, and the hourly
     budgets count nothing. While the settings are unread it is handed
     `null`, so news is held, not let go, for a vault that leaves it on.
     **A rule in flight is never cut off.** The clock runs its due rules one
     after another; the run under way when the switch goes off finishes,
     writing its log, and no rule after it starts (the runner reads whether
     this Mac runs the rules as each clock run's turn comes, as a note's run
     already did). Nothing is killed or interrupted mid-write; the vault
     guard that stops a run when another vault opens is not used for this.
     **Switched on again**, the same runner carries on, as when this Mac
     takes the automations over: its first read is taken as the vault
     opening, so a rule that runs on opening runs then, and a schedule
     missed while off runs once; after that the minute runs what is due, and
     a note's news sets its rule off again. A note that changed while it was
     off sets nothing off.
   - **Meetings** (Granola, Calendar): `granolaSettings`, `granolaPull`,
     `meetingSync` (today's meetings read from Google Calendar as event
     notes, ADR-0046), a new `meetingSyncSettings` (Settings → Google
     Calendar's meetings part: its switch, calendars and Sync now) and a new
     `meetingImport` (the import of meetings that arrive by pull, P28-04, on
     the automations Mac, and the Inbox's "meetings wait for the named Mac").
     Off: no Granola key is asked after and nothing is pulled, on opening, on
     the clock or by Sync now in Settings; no calendar is read for meetings;
     nothing is imported. A Granola pull under way finishes and its toast is
     not shown; a meeting sync under way stops between meetings, writing
     nothing more, as its Stop does; the import asks before each file
     whether it may write, and stops there. Switched on, Granola pulls as on
     opening, the meeting sync runs at once and on its clock, and the import
     catches up, as when this Mac takes the automations over.
     **Meeting notes stay** and open as ordinary notes (there is no Meetings
     page or row: a vault's meeting type is an ordinary type row). The
     Granola key in the Keychain and the Google sign-in stay, as Kindle's
     sign-in does; switch Meetings on to use or remove them.
     **Automations does not require Meetings.** Most rules act on any note,
     and a meeting note made by hand, or by the API, is still a meeting. An
     "After a meeting" rule keeps its row as it was, on and with its
     schedule, and runs on the meetings that still arrive that way; its
     preset stays among the presets.

   **Time blocks are not Meetings.** Two-way block sync with Google Calendar
   (ADR-0030, `blockSync`) is time-blocking: it shares the Google sign-in and
   Settings → Google Calendar with the meetings, and has no switch. It keeps
   running with Meetings off, and so do the card, its sign-in and its blocks
   part; only the card's meetings part goes.

   **The automations Mac.** The setting is per vault, so it is synced:
   switched off on one Mac, Automations is off on the other once it pulls.
   The claim of the Mac that runs the automations
   (`packages/domain/src/sync/automations-claim.ts`, Settings → Sync's "Run
   automations on this Mac") is sync's and is neither taken nor released by
   the switch: with Automations off nothing runs on either Mac, and
   switched on, the rules run where the claim says, as before.

   **Work that starts by itself waits for the settings read.** Until the
   vault's settings note answers, the off list is empty and every feature
   reads as on. That is right for what is drawn — rows, commands and
   Settings show at once, as the sidebar's default order does — but not for
   work: a runner, timer, listener or network call of a switchable feature
   would start for a feature the file switches off. Every entry point a
   switch can take away is classified once, in `KIND_OF` beside
   `FEATURE_OF`, as `'draws'` or `'work'`; the record is exhaustive, so an
   entry point given a feature does not compile until it is classified.
   `STARTS_WORK` is built from it (`kindleSync`, `slackLinkOffer`,
   `chatWork` — the chat's reachability check, window context and turns —
   `automationsRunner`, `granolaPull`, `meetingSync` and `meetingImport`),
   and `workOffered` holds them until the read answers. Runners read
   `working`, which holds only the work entries, so a runner cannot be fed
   from a row's or a page's entry. A failed read still answers, and
   with no vault open nothing runs. The feature chunks' preloads already wait
   for the read. So a Slack link pasted before the answer is a plain paste,
   whatever the file says, and Kindle's first sync comes after it.

5. **What is not gated.** The local API and the MCP server keep answering for
   an off feature. The request is about the view; changing who may call what
   is a separate decision with its own risk (ADR-0016, ADR-0017). So with
   Meetings off the API's Granola Sync now still pulls, and its meeting
   drafts are still written; with Automations off its automation routes
   still list rules, read logs and dry-run.

   **The Ask line.** The Ask switch hides Ask's and the chat's own surfaces
   (pages, panels, commands, shortcuts), not Claude. Other features reach
   Claude through the same `ModelProvider` and keep doing so with Ask off:
   the Inbox's Suggest (now its own entry point, `inboxSuggest`, which no
   switch hides), Skills' Ask Claude… (`skillDraft`) and rules' Claude steps
   (`claudeAutomations`, which is Automations', not Ask's). Settings → Claude stays
   too: its provider and model are what those use. Search by meaning
   (`meaningSearch`) and a note's related notes have their own on/off and no
   switch here; Ask runs no embedding or indexing of its own. The graph's
   data (`useVaultGraph`) is still read with Graph off, since note titles,
   tab names and related notes are drawn from it.

   **What stays with Automations off.** The rules and their logs, read as
   ever. **Undo of runs already made**: a tab on the Automations page shows
   the notice and, under it, each rule whose last run can be undone, with
   "Undo last run", through the runner's one door. The run log and the
   Activity lines (Activity's link to a rule opens that notice). The
   proposals rules made: they are notes in `Inbox/Proposals` and stay on the
   Inbox, to be accepted or refused. The Inbox's own tidy-ups — Suggest and
   Apply (inbox assist, `inboxSuggest`), moving loose notes and old
   meetings, archiving tasks meetings made, filing meetings into projects —
   which are previewed and run by hand, not rules. The API's and MCP's
   automation routes.

6. **Nothing is deleted.** Switching a feature off removes no note, file,
   setting or tab, and closes nothing. Switching it on brings everything back
   where it was.

## Consequences

- A feature's entry points are tested from the registry, not by count:
  switching each feature off must hide exactly the entry points written down
  for it, and an entry point moved to another feature shows in the test.
- An entry point that needs no capability is offered on every platform and
  hidden only by its switch; the capability tests now say "every entry point
  that needs a capability" where they said "every entry point".
- Before a vault's settings are read, every feature is on, so for a vault
  with Reading off its rows show for the moment the read takes, as the
  sidebar's default order does. Its pages wait, as above.
- A comment being typed in a highlight of a literature note's panel, or in
  the reader, is lost if Reading is switched off from another device while
  it is open, as closing the tab would lose it.
- A feature held off by what it requires cannot be switched on in its own
  row; the person switches on what it needs. Nothing is rewritten for it,
  so what another Mac chose for it survives.
- Settings opened from the notice opens at Features with its heading focused;
  opened any other way, it opens at its top as before.
- With Automations off the runner still reads the rules and their logs on
  its minute, as a Mac that does not run them does, so the undo of past runs
  and the API see them current. No rule runs.
- With Meetings off, a vault with an "After a meeting" rule keeps it on; it
  acts on meeting notes made by hand or through the API.
