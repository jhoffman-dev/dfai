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
   at Features. Until the vault's settings have answered, a tab on a
   feature's page shows its empty frame rather than the page, so a kept tab
   on a PDF never loads the reader of a Reading that turns out to be off; an
   overlay a feature's command opened (Add PDF…) closes when its entry point
   stops being offered. Slice 1 gates Reading (PDF and EPUB, the Library, All
   highlights) under three new entry points, `libraryPages`, `documentReader`
   and `addDocuments`. Slice 2 adds four switches:
   - **Kindle** (requires Reading): `kindleSettings`, `kindleCommands` and a
     new `kindleSync`: the sync as the index is ready, its four-hour timer,
     Sync now and Connect, which stop while it is off and start again,
     syncing at once, when it is on. Its toast goes with it.
   - **Ask and Claude chat**: `claudeChat`: the Ask page (`PAGE_ENTRY`), the
     sidebar's Ask, ⌘J, ⇧⌘J, the page bar's Claude and the aside's Claude tab.
     Its page's code (`askScreen`) is a feature preload.
   - **Graph**: a new `graphPage`: the page (`PAGE_ENTRY`), the sidebar's
     Graph and a note's Show in graph; its chunk is a feature preload.
   - **Slack capture**: `slackSettings` and `slackLinkOffer`: Settings →
     Slack, and the paste listener, which is taken off the page while it is
     off (not left to answer nothing), with any offer up at the time.
     Automations and Meetings come in slice 3.

5. **What is not gated.** The local API and the MCP server keep answering for
   an off feature. The request is about the view; changing who may call what
   is a separate decision with its own risk (ADR-0016, ADR-0017).

   **The Ask line.** The Ask switch hides Ask's and the chat's own surfaces
   (pages, panels, commands, shortcuts), not Claude. Other features reach
   Claude through the same `ModelProvider` and keep doing so with Ask off:
   the Inbox's Suggest (now its own entry point, `inboxSuggest`, which no
   switch hides), Skills' Ask Claude… (`skillDraft`) and rules' Claude steps
   (`claudeAutomations`, untouched until slice 3). Settings → Claude stays
   too: its provider and model are what those use. Search by meaning
   (`meaningSearch`) and a note's related notes have their own on/off and no
   switch here; Ask runs no embedding or indexing of its own. The graph's
   data (`useVaultGraph`) is still read with Graph off, since note titles,
   tab names and related notes are drawn from it.

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
