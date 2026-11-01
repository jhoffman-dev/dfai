import { createVaultPath as p } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import { FakeGitHub } from './fake-github.test-support.ts';
import { vaultOver } from './github-vault.test-support.ts';

/**
 * Second attack on PR #718 (#664) against the API's stand-in. Each test pins a
 * bug and is marked `it.fails` until the fix lands; drop the `.fails` then.
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

describe('attack2-718: no twin the Mac sees as one name', () => {
  // `macNameKey` lowercases with toLowerCase, which turns a capital sigma
  // followed by ".md" into σ, while a name typed in lower case ends its word
  // in the final form ς. Unicode case folding, as a case-insensitive disk
  // compares names, maps ς to σ, so the Mac sees one name; the key sees two.
  // Seen: both 'ΟΔΟΣ.md' and 'οδος.md' land on the branch.
  it.fails('refuses a note whose name differs from one there only by a final sigma', async () => {
    const { github, fs, vault } = seeded({ 'ΟΔΟΣ.md': 'upper' });
    await settled(fs.createNote({ vault, path: p('οδος.md'), contents: 'lower' }));
    expect(await github.paths()).toEqual(['ΟΔΟΣ.md']);
  });
});
