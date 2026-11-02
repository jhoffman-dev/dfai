import { describe, expect, it } from 'vitest';
import { diffManifest } from './manifest-diff.ts';

/** A GitHub vault's listing: each note's version is its blob id's prefix (ADR-0053). */
const listed = (path: string, modified: number, size = 10) => ({ path, modified, size });
const held = (...entries: (readonly [string, number, number?])[]) =>
  new Map(entries.map(([path, modified, size = 10]) => [path, { modified, size }]));
const paths = (notes: readonly { path: string }[]) => notes.map(({ path }) => path);

describe('diffManifest: which notes a refresh reads (#666)', () => {
  it('reads nothing when every version and size is as the index holds it', () => {
    const diff = diffManifest({
      listed: [listed('A.md', 0xa1), listed('B.md', 0xb1)],
      held: held(['A.md', 0xa1], ['B.md', 0xb1]),
    });
    expect(diff).toEqual({ stale: [], removed: [], added: [] });
  });

  it('reads a note whose version changed, though its size did not', () => {
    const diff = diffManifest({
      listed: [listed('A.md', 0xa2), listed('B.md', 0xb1)],
      held: held(['A.md', 0xa1], ['B.md', 0xb1]),
    });
    expect(paths(diff.stale)).toEqual(['A.md']);
  });

  it('reads a note whose size changed, though its version did not', () => {
    const diff = diffManifest({ listed: [listed('A.md', 0xa1, 11)], held: held(['A.md', 0xa1]) });
    expect(paths(diff.stale)).toEqual(['A.md']);
  });

  it('reads a new note, and says it was added', () => {
    const diff = diffManifest({
      listed: [listed('A.md', 0xa1), listed('New.md', 0xc1)],
      held: held(['A.md', 0xa1]),
    });
    expect(paths(diff.stale)).toEqual(['New.md']);
    expect(diff.added).toEqual(['New.md']);
  });

  it('says which held notes the vault no longer lists, and reads none for them', () => {
    const diff = diffManifest({
      listed: [listed('A.md', 0xa1)],
      held: held(['A.md', 0xa1], ['Gone.md', 0xd1]),
    });
    expect(diff.removed).toEqual(['Gone.md']);
    expect(diff.stale).toEqual([]);
  });

  it('reads a note named to be rechecked, whatever its version', () => {
    const diff = diffManifest({
      listed: [listed('A.md', 0xa1), listed('B.md', 0xb1)],
      held: held(['A.md', 0xa1], ['B.md', 0xb1]),
      recheck: ['B.md', 'Not listed.md'],
    });
    expect(paths(diff.stale)).toEqual(['B.md']);
  });

  it('reads every note against an empty manifest: the first build', () => {
    const diff = diffManifest({ listed: [listed('A.md', 1), listed('B.md', 2)], held: new Map() });
    expect(paths(diff.stale)).toEqual(['A.md', 'B.md']);
    expect(diff.added).toEqual(['A.md', 'B.md']);
  });

  it('hands back the listed notes themselves, for reading', () => {
    const note = { ...listed('A.md', 1), name: 'A.md' };
    expect(diffManifest({ listed: [note], held: new Map() }).stale[0]).toBe(note);
  });
});
