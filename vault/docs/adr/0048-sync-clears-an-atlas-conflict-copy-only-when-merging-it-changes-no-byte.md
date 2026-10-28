---
type: adr
id: ADR-0048
title: Sync clears an .atlas conflict copy only when merging it changes no byte
status: proposed
date: 2026-10-28
---

# ADR-0048 — Sync clears an .atlas conflict copy only when merging it changes no byte

## Context

Before #233 (PR #234), a sync kept a conflict copy of every `.atlas/` file
both Macs changed, even when DFAI had written both versions by itself as the
vault opened — a built-in type gaining the keys a newer build ships, say.
Those copies sit under `Sync conflicts/atlas/`, for example
`Sync conflicts/atlas/types/meeting (conflict from Laptop).md` and
`Sync conflicts/atlas/migrations/type-properties (conflict from Laptop).md`.
#234 stopped new ones. The old ones stay until someone deletes them, and a
copy nobody needs is noise that teaches a person to ignore copies that matter.

Sync touches a real vault on two Macs, so the rule for deleting one has to be
the strictest that still clears these: never delete a copy that holds
anything its live file does not.

## Decision

### "Changes nothing" means byte-equal

On each sync, after the other Macs' changes are merged in, every copy under
`Sync conflicts/atlas/` that git tracks is merged into its live `.atlas/`
file with the rule sync already uses for the two Macs' versions
(`mergeSettings`, ADR-0003's byte-preserving merge by keys) — with no base,
the live file as the side kept, the copy as the side folded in. The copy is
cleared when, and only when, **the result is byte for byte the live file as
it is**.

The merge keeps the live file whole and folds in only top-level keys or
block-map entries the copy has and the live file lacks, as written. So the
live file coming back unchanged means: every key and entry the copy shares
with it is written the same, the bodies are the same, and the copy has no
key or entry the live file lacks. For the record of shipped properties, the
union of the two records is the live record exactly.

Semantic equality — the same values read from the frontmatter, in any key
order or whitespace — was rejected. It is looser for no gain: the copies
this is for are older versions DFAI wrote itself, which the live file holds
written the same. A copy that differs only in whitespace, key order or a
comment was written or touched by a person, and a person decides about it.

### What keeps a copy

Each of these is tested (`clear-settled-copies.test.ts`,
`two-macs.settled-copies.test.ts`):

- it differs only in whitespace or key order; in one value; by a key or a
  property the live file lacks; in its body;
- the live file or the copy is missing, cannot be read as text, or has
  frontmatter the merge cannot cut into keys;
- it is a copy of a copy (` (conflict from A) (conflict from B)`): its live
  file is the first copy, not an `.atlas/` file;
- either file reads differently — text or modified time — when read again
  just before the Trash, so a write made while the check ran is never missed;
- git still holds it in conflict;
- this sync made it: Activity is about to tell the person of it;
- the Trash refuses it (said in Activity as a warning).

### After the merge, on every Mac, into the Trash

- **After the merge, not before.** The check is made against the live file
  the push will send. When the other Mac took a key off the live file that
  the copy still has, the copy stays (tested with two clones and a bare
  remote).
- **The Trash, not an unlink**, through `VaultFsPort.trashEntry`, as every
  other delete in DFAI. The removal is committed and pushed by the same
  sync, so the other Mac loses the copy too, and git's history keeps it.
- **On every Mac that syncs**, as settling a conflict is. The automations
  Mac gate (ADR-0035) is for acts whose result two Macs would each write
  differently; clearing is not one. Two Macs clearing the same copy delete
  it on both sides, which git merges cleanly; a copy one Mac edited while
  the other cleared it comes back as a modify/delete conflict, and sync keeps
  the version that exists (tested).
- **Activity says each one**:
  `Cleared the conflict copy <copy>: <live file> already holds everything in it. It is in the Trash.`

## Consequences

- The old copies go on the first sync after this ships, one Activity line
  each, with no step for the person.
- With no base, the check cannot tell a key the other Mac removed from one
  this Mac added: a copy that lacks a key the live file has is cleared. That
  copy holds nothing the live file lacks, which is the invariant; what is
  lost is only the hint that the other Mac once removed the key, and the
  copy is in the Trash and in git's history.
- There is a moment between the second read and the Trash in which a write
  is not seen; the host's `trashEntry` takes no expected time. A write to
  the copy there goes to the Trash with it, where it can be recovered; one
  to the live file is this Mac's own edit, made after the check.
- Each sync lists git's index once (`git ls-files --stage`).
