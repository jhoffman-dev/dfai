---
type: adr
id: ADR-0054
title: A refused web save is kept as a conflict copy, named as the desktop names its own
status: proposed
date: 2026-11-02
---

# A refused web save is kept as a conflict copy, named as the desktop names its own

## Context

Her MacBook syncs the vault by git; her iPad writes it through the GitHub API
(#664, PR #718). When both change one note before they meet, one of two
things happens (#665):

- the web commits first, and the desktop's next sync merges a remote change;
- the desktop pushes first, and the web's save is refused with the
  changed-on-disk refusal, because the note's blob or the branch head moved.

The desktop already settles the first case without losing text: its version
stays in place, the other side's is kept beside it as
`<name> (conflict from <Mac>).<ext>` (U-29, ADR-0048). The web had no
equivalent: its editor offered only Overwrite (losing the desktop's text) or
Discard (losing the web's).

## Decision

1. **One naming rule.** A refused web save is kept with the desktop's own
   rule, `conflictCopyPath`, with the web as the device: `WEB_DEVICE`,
   `DFAI web`. `Plan.md` refused on the web is kept as
   `Plan (conflict from DFAI web).md`, numbered past names already taken; a
   copy of a `.atlas` file goes to `Sync conflicts/atlas/` as on the desktop.
   The rule (`copyOfRefusedWrite`, domain) keeps the refused version whole and
   leaves the newer version in place, untouched; nothing is kept when the two
   are the same text.
2. **The use-case** (`keepRefusedAsCopy`, application) reads the note as it
   now stands, lists the copy's folder, and _creates_ the copy, so it never
   writes over anything: a name taken meanwhile fails it, and the editor
   keeps the edits on screen with the reason.
3. **The editor offers it** as "Keep mine as a copy" beside the existing
   choices wherever its ports name a device (the web build names
   `DFAI web`). "Discard my changes" is the "reload the newer version"
   choice. The desktop does not name a device yet, so it is unchanged.
4. **Web commits are authored `DFAI web`** (`WEB_COMMIT_AUTHOR`,
   `dfai@web.local`), as the desktop's are `DFAI on <Mac>`.
5. **The desktop names a web edit's copy for the web.** Where the remote's
   last commit is not a DFAI sync, its author decides (`deviceOfCommit`): a
   commit authored `DFAI web` gives `(conflict from DFAI web)`, so a copy made
   on either side carries the same name. The port gains `remoteAuthor`.

## Consequences

- Neither ordering loses text: the two-Macs harness's web writer
  (`web-writer.test-support.ts`) commits through the GitHub API stand-in into the
  very bare repository the Macs sync with, and its tests hold every typed
  version to be the whole of some file on both Macs and on the branch.
- Overwrite is still offered on the web, as on the desktop. Wiring the GitHub
  vault into the web build (#666/#667) should decide whether to drop it there.
- A save racing a desktop push can make the desktop's push be refused as not
  a fast-forward. Nothing is written over; the next sync merges it.
