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

### And the live file lacks nothing but what DFAI wrote into it

A merge that changes nothing says the copy holds nothing more. It does not
say why the live file holds more. Before #234, a person could take a
property `p` off a type on Mac B while Mac A's newer build added a shipped
property `q`; git kept A's file (with `p` and `q`) live and B's as the copy.
That copy adds nothing — and it is the only sign that the live file undid
the person's deletion. The same goes for a copy trimmed by hand.

So the copy goes only when **every key the live file has beyond the copy
is one DFAI wrote itself**:

- for a type (`.atlas/types/…`), a whole entry of its `properties` map that
  the vault's record (`.atlas/migrations/type-properties.md`) lists under
  `added` for that type's `name` — the keys DFAI wrote into that file. The
  record is keyed by the folded name (trimmed, lower case), so `name:
Meeting` finds what was recorded for `meeting`;
- for the record itself, a key DFAI ships on that type
  (`SHIPPED_PROPERTIES`);
- for any other `.atlas` file — a view, the settings, an automation —
  nothing: its copy goes only when its frontmatter says what the live
  file's does, at every depth (`sameFrontmatterValue`).

"Beyond the copy" is looked for at every depth (`liveExtras` walks every
map both sides have, and gives each path the copy lacks). The merge by keys
folds the entries of any block map, not only `properties`, so a key the copy
lacks one map down — an automation's `when.status`, a view's
`filters.owner`, the settings' `sync.every`, a type's `display.color` —
leaves the merge byte-equal, and only this walk sees it (verification review
of PR #599). A top-level key, a key inside a property, or a value the two
say differently always keeps the copy. A record that cannot be read counts
as one that lists nothing. (James may widen this;
it is the strict choice made on review of PR #599.)

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
- the live file has a key or a property the copy lacks that DFAI did not
  write (see above): the pre-#234 deletion, a copy trimmed by hand, a
  shipped key the record does not say DFAI added, a vault with no record;
- it is the record, and its JSON names a key twice: a reader keeps only the
  last, so it was not written by DFAI and what the first held would be lost
  (the merge by keys, #233, refuses it too). The check runs only once the
  file is known to be DFAI's text around the one JSON line that parsed, and
  text that is not JSON counts as not DFAI's rather than throwing, so a
  record broken past its first block never stops a sync;
- the live file or the copy is missing, cannot be read as text, or has
  frontmatter the merge cannot cut into keys;
- it is a copy of a copy (` (conflict from A) (conflict from B)`): its live
  file is the first copy, not an `.atlas/` file;
- either file reads differently — text or modified time — when read again
  before the Trash is asked;
- either file is not as read when the host comes to trash the copy (below):
  Activity says so, once;
- git still holds it in conflict;
- this sync made it: Activity is about to tell the person of it;
- the Trash refuses it: said in Activity as a warning once this session,
  and again only when the copy or the outcome changes.

### After the merge, on every Mac, into the Trash

- **After the merge, not before.** The check is made against the live file
  the push will send. When the other Mac took a key off the live file that
  the copy still has, the copy stays (tested with two clones and a bare
  remote).
- **The Trash, not an unlink**, through `VaultFsPort.trashEntry`, as every
  other delete in DFAI.
- **The check and the Trash are one step for the host.** `trashEntry` takes
  `unchanged`: the copy and its live file, each with the modification time
  and the text it was read with. The host (`trash_entry_at_unless_changed`
  in `vault_entries.rs`) compares each file's time and SHA-256 with them and
  trashes only if all match, inside the vault's change turn, so no write the
  app makes lands between the checks and the Trash. Otherwise it refuses
  with `EntryChangedError` and nothing moves. The live file is held in the
  same step rather than checked again after: a check after the Trash could
  only report a loss, not prevent it. The comparison is plumbing, as
  `write_text_file`'s `expectedModified` is; what to hold still is decided
  in TypeScript. The removal is committed and pushed by the same
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
  this Mac added. It does not try: a copy that lacks anything but what DFAI
  wrote into the live file is kept for a person. Copies of views, settings
  and automations go only when they are the live file exactly. A property
  DFAI added and a person later took off on the copy's Mac is the one
  deletion this still clears; the copy is in the Trash and in git's history.
- A program other than DFAI writing a file inside the host's check-and-trash
  step is not held off (the change turn orders the app's own writes); the
  digest still refuses any write that landed before the check.
- `trashEntry` gained an optional `unchanged`; every other delete leaves it
  out and behaves as before.
- Each sync lists git's index once (`git ls-files --stage`).
