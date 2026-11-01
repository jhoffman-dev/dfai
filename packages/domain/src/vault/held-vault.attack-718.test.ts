import { describe, expect, it } from 'vitest';
import { HELD_REFUSAL, heldMove, heldPlaceRefusal, type HeldVault } from './held-vault.ts';

/**
 * Attack on PR #718 (#664). Each `it.fails` pins a bug in the held vault's
 * rules: it passes while the bug is there and goes red once it is fixed, when
 * `.fails` comes off.
 */
const vault = (files: string[], folders: string[] = []): HeldVault<{ size: number }> => ({
  files: new Map(files.map((path) => [path, { size: 1 }])),
  folders: new Set(folders),
});

describe('attack-718: the held vault never moves onto another entry', () => {
  // A repo made on GitHub or Linux can already hold names that differ only in
  // case. A case-only rename onto the other one is planned as a plain rename,
  // so the move lands on it and the file there is overwritten.
  it.fails('refuses a case-only rename when the other-case name is already a file there', () => {
    const twins = vault(['a.md', 'A.md']);
    expect(heldMove(twins, { from: 'a.md', to: 'A.md' })).toEqual({
      refused: HELD_REFUSAL.nameTaken,
    });
  });

  it.fails(
    'refuses a case-only folder rename onto a folder already there in the other case',
    () => {
      const twins = vault(['Notes/x.md', 'notes/x.md']);
      expect(heldMove(twins, { from: 'Notes', to: 'notes' })).toEqual({
        refused: HELD_REFUSAL.nameTaken,
      });
    },
  );
});

describe('attack-718: no twin a Mac sees as one name', () => {
  // The Mac's disk takes NFC and NFD spellings of a name as one, as it does
  // case; heldNameLike only folds case, so the NFD twin of a note is created.
  it.fails('refuses a new name that is an existing one in another Unicode normal form', () => {
    const nfc = 'Café.md';
    const nfd = 'Café.md';
    expect(heldPlaceRefusal(vault([nfc]), { path: nfd, taken: HELD_REFUSAL.noteTaken })).toBe(
      HELD_REFUSAL.noteTaken,
    );
  });
});
