import { describe, expect, it } from 'vitest';
import { conflictCopyPath, isConflictCopyPath } from './conflict-copy.ts';

/**
 * PR #627 attack: a Mac's name can hold any character — "Mara's MacBook Pro
 * (2)", "Mac)mini" — and a copy named for it must still read as a copy, or
 * the meeting import and the waiting count take it for a meeting. Seeded, so
 * a failure names its case.
 */

/** mulberry32: the same seed, the same run. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [...'abcXYZ019 ()().-_:/\\\'"é漢😀\t[]{}#'];

function text(rng: () => number, most: number): string {
  const length = Math.floor(rng() * most);
  return Array.from({ length }, () => ALPHABET[Math.floor(rng() * ALPHABET.length)]!).join('');
}

/** A note's name with no slash, as a folder entry holds it. */
const nameOf = (rng: () => number) => text(rng, 30).replaceAll('/', '').trim() || 'Note';

const PLACES = ['', 'Inbox/Meetings/', 'Meetings/2026/10/', '.atlas/views/', 'Projects/A (b)/'];
const EXTENSIONS = ['.md', '.markdown', '.png', ''];

describe('isConflictCopyPath, for any Mac name (attack on PR #627)', () => {
  it('reads back every copy conflictCopyPath makes, numbered or not, over 2000 seeds', () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const rng = seeded(seed);
      const place = PLACES[Math.floor(rng() * PLACES.length)]!;
      const extension = EXTENSIONS[Math.floor(rng() * EXTENSIONS.length)]!;
      const path = `${place}${nameOf(rng)}${extension}`;
      const mac = text(rng, 60);
      const first = conflictCopyPath({ path, mac, taken: new Set([path]) });
      const second = conflictCopyPath({ path, mac, taken: new Set([path, first]) });
      expect({ seed, mac, first, read: isConflictCopyPath(first) }).toMatchObject({ read: true });
      expect({ seed, mac, second, read: isConflictCopyPath(second) }).toMatchObject({
        read: true,
      });
    }
  });

  it('never takes an ordinary note for a copy, over 2000 seeds', () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const rng = seeded(seed);
      const place = PLACES[Math.floor(rng() * PLACES.length)]!;
      const extension = EXTENSIONS[Math.floor(rng() * EXTENSIONS.length)]!;
      const path = `${place}${nameOf(rng)}${extension}`;
      expect({ seed, path, read: isConflictCopyPath(path) }).toMatchObject({ read: false });
    }
  });

  it('reads names macOS gives a second Mac, and one with a bracket inside', () => {
    for (const mac of ["Mara's MacBook Pro (2)", 'Mac)mini', '(Studio)', 'Tobias’s iMac (3) (4)']) {
      const path = 'Inbox/Meetings/2026-10-06 Standup.md';
      expect(isConflictCopyPath(conflictCopyPath({ path, mac, taken: new Set([path]) }))).toBe(
        true,
      );
    }
  });

  it('does not take a copy of a folder for a copy of the file under it', () => {
    expect(isConflictCopyPath('Projects/Ideas (conflict from Laptop)/Plan.md')).toBe(false);
  });
});
