import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import { fakeVaultFs } from '../testing/fake-ports.ts';
import { countOtherFiles } from './delete-entry.ts';
import { VaultAccessError } from './ports.ts';

/*
 * Deleting a folder that holds links, or is one (#169, review of PR #646):
 * the Trash takes a link as a link, so the question counts nothing at its
 * target, names the link instead, and never walks through it.
 */

const ESCAPES = 'path escapes the vault';
const dir = (path: string, link = false): VaultEntry => ({
  kind: 'directory',
  name: path.split('/').at(-1) ?? '',
  path: createVaultPath(path),
  ...(link && { link: true as const }),
});
const file = (path: string): VaultEntry => ({
  kind: 'file',
  name: path.split('/').at(-1) ?? '',
  path: createVaultPath(path),
});
const folder = (path: string) => ({ path: createVaultPath(path), kind: 'directory' as const });

/** A host that answers `listings`, refuses anything under `outside`, and counts what it lists. */
function host(listings: Record<string, VaultEntry[]>, outside: readonly string[] = []) {
  const listed: string[] = [];
  const fs = fakeVaultFs({
    listDirectory: async (path) => {
      listed.push(path);
      if (outside.some((link) => path === link || path.startsWith(`${link}/`))) {
        throw new VaultAccessError(ESCAPES);
      }
      const entries = listings[path];
      if (entries === undefined) throw new VaultAccessError('no such folder');
      return entries;
    },
  });
  return { fs, listed };
}

describe('countOtherFiles with links (#169)', () => {
  it('names a subfolder linked out of the vault instead of failing on it', async () => {
    const { fs } = host(
      {
        '': [dir('Old')],
        Old: [file('Old/a.md'), file('Old/b.png'), dir('Old/out', true)],
      },
      ['Old/out'],
    );

    const others = await countOtherFiles({
      fs,
      entry: folder('Old'),
      notes: [createVaultPath('Old/a.md')],
    });

    expect(others).toEqual({ link: false, count: 1, links: ['Old/out'], reachedThrough: null });
  });

  it('does not walk links back up: two of them are two names, not 2^32 listings', async () => {
    // Each link lists as the folder it points back to, as the host follows it.
    const loop = (at: string): VaultEntry[] => [
      dir(`${at}/a`, true),
      dir(`${at}/b`, true),
      file(`${at}/x.png`),
    ];
    const listings = new Proxy({} as Record<string, VaultEntry[]>, {
      get: (_, at: string) => (at === '' ? [dir('Loop')] : loop(at)),
    });
    const { fs, listed } = host(listings);

    const others = await countOtherFiles({ fs, entry: folder('Loop'), notes: [] });

    expect(others).toEqual({
      link: false,
      count: 1,
      links: ['Loop/a', 'Loop/b'],
      reachedThrough: null,
    });
    expect(listed.length).toBeLessThanOrEqual(2);
  });

  it('does not look in a folder that is itself a link', async () => {
    const { fs, listed } = host({ '': [dir('Alias', true)] }, ['Alias']);

    const others = await countOtherFiles({ fs, entry: folder('Alias'), notes: [] });

    expect(others).toEqual({ link: true, count: 0, links: [], reachedThrough: null });
    expect(listed).toEqual(['']);
  });
});
