---
type: adr
id: ADR-0053
title: A file's version is not its time
status: proposed
date: 2026-11-01
---

# A file's version is not its time

## Context

Every read through the vault port (`VaultFsPort`) gives a file's `modified`.
It does two jobs. It is the **version**: what a write is refused against
(`expectedModified`, `AsRead`, `ifModified`) and what the index spots a change
by. On the desktop it is also the **time**: the Rust host reports the file's
mtime, and the app reads it as epoch milliseconds.

The GitHub vault (#664, PR #718) has no per-file time: a tree gives each
file's blob sha, not when it changed. Its `modified` is the first 52 bits of
that sha. It is an exact version and no time at all. Values run up to 2^52
(about 4.5e15) against about 1.8e12 for now, so read as a time, nearly every
note looks written after any moment you name (issue #720).

The readers that take `modified` as a time:

- **The created-rule catch-up** (`arrivalsMissed` → `missedArrivals`): a
  meeting counts as missed when it was written after the rule's own file.
  This one **writes**. Read as times, the versions would run the rule on
  nearly every meeting in the vault.
- **The meeting-items backfill test** (`savedAt` → `ruleSince` in
  `owners-tasks`): a meeting from before the rule's file only gets proposals.
  This writes too.
- **The fresh-pull gate's arrival** (`arrivedAt`): a file must be older than
  the last completed pull. The gate only reads times in a vault that syncs by
  git, which is desktop-only (`syncByGit`), but it guards writes. The
  meetings-waiting count dates each waiting meeting against that pull the
  same way (`readWaitingMeetings` → `pulledAfterArrival`).
- **Staleness and order** on Today and in the weekly review (`ReviewTask`
  rows from the index): waiting days, "untouched for more than N days",
  oldest first.
- **Index queries that read `files.modified`** as a time: the query
  language's `modified` field, inbox order, the research library's sort and
  dates, the assistant's waiting days, link hints, done this week. None of
  these writes.
- **Ordering only**, of things read straight from the vault: mention
  suggestions, proposals, chat sessions.
- **`use-note`'s pick** between the write it landed and the note it holds
  compared the two `modified`s with `>=`. That orders versions, and in the
  GitHub vault a queued save would often start from the older read and be
  refused.

ADR-0051's map holds none of the writing readers to the desktop: automations
without a Claude step run on the web (`ruleHeldByPlatform` holds only Claude
steps).

## Options

- **(a) Split the port.** `version` for refusals, and a time `modified` that
  may be unknown (`null`).
- **(b) Per-file commit times from GitHub.** About one commits call per path,
  on every listing: too slow and costly for a vault of thousands of notes.
- **(c) Hold every time-reading feature to the desktop.** Today's waiting
  days, the weekly review and the catch-up would all go from the web, though
  only the writing ones are dangerous.
- **The head commit's time for every note** (from the issue). Every note
  would look written at the last commit, so after that commit every meeting
  is "new since" the rule: as unsafe as the versions.

## Decision

**(a), without the rename.** `modified` stays the version on every host, so
refusals and change detection stay exactly as they are. Beside it, a read may
carry **`modifiedAt: number | null`** (`WrittenAt` on `NoteListing`,
`NoteFile`, `NoteContents`, and `IndexedNote`):

- **Left out**, the host's `modified` is also its time. That is the desktop:
  the Rust host and its TypeScript bridge are unchanged, and so is every fake
  in the tests.
- **`null`**: the vault cannot tell. The GitHub vault says this on every read.
- A number: a time apart from the version. Nothing gives one yet; option (b)
  would, if it is ever worth the calls.

Every reader of a time asks **`writtenAt(file)`**, never `modified`. The rule
for an unknown time: **it is never "changed since" anything.** So:

- the catch-up finds nothing missed (as when the rule's file cannot be read);
- `ruleSince` is null, so every meeting is a backfill: proposals only;
- the fresh-pull gate stays shut on an arrival it cannot date;
- a waiting meeting that cannot be dated is counted as waiting. Read as
  after every pull, no pull would ever count it, and the count writes
  nothing: it only says what waits;
- `use-note` decides by the pane's own order, never by `modified`: a held
  `landed` is always the newer, since a read begun after it lets it go and a
  read begun before it is not shown. The desktop's choices are the same;
- a task with an unknown time is never stale, has no waiting days, and sorts
  after the tasks whose time is known.

We keep the name `modified` for the version because renaming it reaches
every write in the app and the Rust host, for no change in behaviour.

## What the web loses

- The **catch-up when DFAI opens** for `created` rules on meetings. A meeting
  that arrives while the web app is open is still heard and run on; one that
  arrived while it was shut waits for a run by hand, or for the desktop.
- **Tasks from meeting items** made on the web are proposals only (the
  backfill path), never written straight in.
- **Waiting days and staleness**: the web's Today shows no waiting days, and
  its weekly review lists no stale tasks.
- **Ordering by time** of things read from the vault (mentions, proposals,
  chat sessions) follows the version: stable, but not by recency.

## Consequences

- **The browser index (#666) owes two things.** It keeps the version in its
  manifest, for change detection. Its time column, which every query reads
  as `files.modified`, holds `writtenAt(note)`, which is NULL for the GitHub
  vault. `reviewTask` already reads NULL as unknown. Before #666 ships, the
  other row readers need the same care:
  - `inboxKeyOf` (`Number(null)` is 0);
  - the library's and `research-text`'s dates (unknown, not 1970);
  - `daysWaited(row.modified)` in `assistant-items.ts` (a NULL date there
    must read as no wait, not as a day);
  - `MAX(files.modified)` in the link hints (NULL rows rank last, not first);
  - the done query's range in `review-query.ts` (`f.modified >= ? AND
f.modified < ?`): NULL falls outside it, so a task done on the web is
    never "done this week" until the index can date it.
    The session sample vault already reports `modifiedAt: null`.
- Wiring the GitHub vault into `composeWeb` is no longer blocked by this.
- A new reader of a file's time must use `writtenAt` and say what an unknown
  time means for it. Anything that writes must treat it as "nothing changed".
