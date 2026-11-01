import { describe, expect, it } from 'vitest';
import {
  HELD_REFUSAL,
  heldBinaryWrite,
  heldChildren,
  heldMove,
  heldNameLike,
  heldPathRefusal,
  heldPlaceRefusal,
  heldWalk,
  type HeldVault,
} from './held-vault.ts';

/**
 * The host's rules for a vault held as a map (#664). The whole contract runs
 * against both vaults that use them (vault-fs-contract.ts); these pin the
 * rules themselves.
 */
const vault = (files: string[], folders: string[] = []): HeldVault<{ size: number }> => ({
  files: new Map(files.map((path) => [path, { size: 1 }])),
  folders: new Set(folders),
});
const seeded = vault(['Welcome.md', 'Projects/Old/Plan.md'], ['Empty']);

describe('a vault held as a map, by the host’s rules', () => {
  it('refuses odd segments and git’s folder in any case, and takes the root', () => {
    expect(heldPathRefusal('')).toBeNull();
    expect(heldPathRefusal('a//b.md')).toContain('not allowed');
    expect(heldPathRefusal('a/./b.md')).toContain('not allowed');
    expect(heldPathRefusal('x/.GiT/config')).toBe(HELD_REFUSAL.gitFolder);
    expect(heldPathRefusal('a\0b')).toBe(HELD_REFUSAL.nullByte);
  });

  it('sees one name where only the case differs, folders implied by a file among them', () => {
    expect(heldNameLike(seeded, 'projects/old')).toBe('Projects/Old');
    expect(heldNameLike(seeded, 'EMPTY')).toBe('Empty');
    expect(heldNameLike(seeded, 'Projects/New')).toBeNull();
    expect(heldPlaceRefusal(seeded, { path: 'welcome.MD', taken: 'taken' })).toBe('taken');
    expect(heldPlaceRefusal(seeded, { path: 'Nope/a.md', taken: 'taken' })).toBe(
      HELD_REFUSAL.noFolder,
    );
    expect(heldPlaceRefusal(seeded, { path: 'Empty/a.md', taken: 'taken' })).toBeNull();
  });

  it('moves a folder with everything under it, never into itself, and a case-only rename is its own', () => {
    expect(heldMove(seeded, { from: 'Projects', to: 'Areas' })).toEqual({
      renames: [['Projects/Old/Plan.md', 'Areas/Old/Plan.md']],
    });
    expect(heldMove(seeded, { from: 'Projects', to: 'Projects/Old/In' })).toEqual({
      refused: HELD_REFUSAL.intoItself,
    });
    expect(heldMove(seeded, { from: 'Welcome.md', to: 'welcome.md' })).toEqual({
      renames: [['Welcome.md', 'welcome.md']],
    });
    expect(heldMove(seeded, { from: 'Welcome.md', to: 'empty' })).toEqual({
      refused: HELD_REFUSAL.nameTaken,
    });
    expect(heldMove(seeded, { from: 'Gone.md', to: 'x.md' })).toEqual({
      refused: HELD_REFUSAL.noEntry,
    });
    expect(heldMove(seeded, { from: 'Projects', to: 'Projects Old' })).toEqual({
      renames: [['Projects/Old/Plan.md', 'Projects Old/Old/Plan.md']],
    });
  });

  it('writes bytes from 0, appends at exactly the length, replaces only from 0', () => {
    const asked = { path: 'Welcome.md', length: 1, replace: false, sizeThere: 1 };
    expect(heldBinaryWrite(seeded, { ...asked, offset: 1 })).toEqual({ how: 'append' });
    expect(heldBinaryWrite(seeded, { ...asked, offset: 2 })).toEqual({
      refused: HELD_REFUSAL.wrongLength,
    });
    expect(heldBinaryWrite(seeded, { ...asked, offset: 0 })).toEqual({
      refused: HELD_REFUSAL.fileTaken,
    });
    expect(heldBinaryWrite(seeded, { ...asked, offset: 0, replace: true })).toEqual({
      how: 'replace',
    });
    expect(heldBinaryWrite(seeded, { ...asked, offset: 1, replace: true })).toEqual({
      refused: HELD_REFUSAL.fromZero,
    });
    expect(heldBinaryWrite(seeded, { ...asked, path: 'Empty', offset: 0, replace: true })).toEqual({
      refused: HELD_REFUSAL.isDirectory,
    });
    expect(heldBinaryWrite(seeded, { ...asked, path: 'Gone.png', offset: 3 })).toEqual({
      refused: HELD_REFUSAL.noEntry,
    });
  });

  it('lists a folder’s children by name, and refuses a file or a missing one as a folder', () => {
    expect(heldChildren(seeded, '')).toEqual({
      children: [
        { kind: 'directory', path: 'Empty' },
        { kind: 'directory', path: 'Projects' },
        { kind: 'file', path: 'Welcome.md' },
      ],
    });
    expect(heldChildren(seeded, 'Welcome.md')).toEqual({ refused: HELD_REFUSAL.notFolder });
    expect(heldChildren(seeded, 'Gone')).toEqual({ refused: HELD_REFUSAL.noEntry });
  });

  it('walks no deeper than told, skipping by name only', () => {
    expect(heldWalk(seeded, { skipDirectories: [], maxDepth: 1 })).toEqual(['Welcome.md']);
    expect(heldWalk(seeded, { skipDirectories: ['Old'], maxDepth: 9 })).toEqual(['Welcome.md']);
    expect(heldWalk(seeded, { skipDirectories: ['Projects/Old'], maxDepth: 9 })).toHaveLength(2);
  });
});
