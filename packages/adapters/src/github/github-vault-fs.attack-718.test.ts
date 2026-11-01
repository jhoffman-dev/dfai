import { createVaultPath as p } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import { FakeGitHub } from './fake-github.test-support.ts';
import { vaultOver } from './github-vault.test-support.ts';

/**
 * Attack on PR #718 (#664) against the API's stand-in. Each `it.fails` pins a
 * bug: it passes while the bug is there and goes red once it is fixed, when
 * `.fails` comes off.
 */
function seeded(files: Record<string, string>) {
  const github = new FakeGitHub({ files });
  return { github, ...vaultOver(github) };
}
const settled = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe('attack-718: a move never overwrites a file on the branch', () => {
  // Seen: the move commits, A.md now holds "lower", and "UPPER" is gone from the branch.
  it.fails(
    'keeps the other-case twin’s text when a case-only rename is asked onto it',
    async () => {
      const { github, fs, vault } = seeded({ 'a.md': 'lower', 'A.md': 'UPPER' });
      await settled(fs.moveEntry({ vault, from: p('a.md'), to: p('A.md') }));
      expect(await github.textAt('A.md')).toBe('UPPER');
      expect(await github.textAt('a.md')).toBe('lower');
    },
  );

  // Seen: notes/x.md now holds "one"; "two" is gone from the branch.
  it.fails('keeps the files of an other-case folder twin a folder is renamed onto', async () => {
    const { github, fs, vault } = seeded({ 'Notes/x.md': 'one', 'notes/x.md': 'two' });
    await settled(fs.moveEntry({ vault, from: p('Notes'), to: p('notes') }));
    expect(await github.textAt('notes/x.md')).toBe('two');
    expect(await github.textAt('Notes/x.md')).toBe('one');
  });
});

describe('attack-718: no twin the Mac sees as one name', () => {
  // Seen: both spellings land on the branch; a Mac checkout holds only one of them.
  it.fails(
    'refuses a note whose name is an existing note’s in another Unicode normal form',
    async () => {
      const { github, fs, vault } = seeded({ 'Café.md': 'nfc' });
      await settled(fs.createNote({ vault, path: p('Café.md'), contents: 'nfd' }));
      expect(await github.paths()).toEqual(['Café.md']);
    },
  );
});

describe('attack-718: one odd name never hides the whole vault', () => {
  // Seen: listNotes and listDirectory('') throw InvalidVaultPathError ("contains a
  // backslash") for the one file, so the iPad lists no note at all.
  it.fails('still lists the other notes when the repo holds a name with a backslash', async () => {
    const { fs } = seeded({ 'a\\b.md': 'made on Linux', 'Welcome.md': '# Welcome\n' });
    const notes = await fs.listNotes({ skipDirectories: [], maxDepth: 8 });
    expect(notes.map(({ path }) => path)).toContain('Welcome.md');
  });
});
