import { describe, expect, it } from 'vitest';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import { fakeVaultFs } from '../testing/fake-ports.ts';
import { countOtherFiles, previewDeletion } from './delete-entry.ts';
import { VaultAccessError } from './ports.ts';

/*
 * Attack on PR #646 (a3f555c5): a folder reached THROUGH a link to a folder
 * inside the vault. The tree lists a link's children (listDirectory follows
 * in-vault links), so `Work/Alias/Plans` is shown and can be deleted. The
 * Trash then takes the real `Shelf/Plans` and the note in it. `isListedAsLink`
 * only checks the last segment, and the index holds the note under its real
 * path, so the question miscounts what goes.
 */

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

/** `Work/Alias` is a link to `Shelf`; the host follows it, as it does in-vault links. */
const listings: Record<string, VaultEntry[]> = {
  '': [dir('Work'), dir('Shelf')],
  Work: [dir('Work/Alias', true)],
  'Work/Alias': [dir('Work/Alias/Plans')],
  'Work/Alias/Plans': [file('Work/Alias/Plans/garden.md')],
  Shelf: [dir('Shelf/Plans')],
  'Shelf/Plans': [file('Shelf/Plans/garden.md')],
};
const fs = fakeVaultFs({
  listDirectory: async (path) => {
    const entries = listings[path];
    if (entries === undefined) throw new VaultAccessError('no such folder');
    return entries;
  },
});
/** The index walks no links, so it knows the note only by its real path. */
const indexed = [createVaultPath('Shelf/Plans/garden.md')];
const throughLink = { path: createVaultPath('Work/Alias/Plans'), kind: 'directory' as const };

describe('deleting a folder reached through a link (attack 646b)', () => {
  it.fails('does not count a note reached through a link as an "other file"', async () => {
    const counted = await countOtherFiles({ fs, entry: throughLink, notes: indexed });
    // Observed: { link: false, count: 1, links: [] } -> "The 1 other file in it goes too."
    expect(counted.count).toBe(0);
  });

  it.fails('warns of unsaved typing in a note the Trash takes through a link', () => {
    const preview = previewDeletion({
      entry: throughLink,
      notePaths: indexed,
      editors: { state: (path) => (path === indexed[0] ? 'dirty' : 'clean') },
    });
    // Observed: notes [] and unsaved [] -> "It has no notes in it.", no warning,
    // and deleteEntry never abandons the dirty pane on Shelf/Plans/garden.md.
    expect(preview.unsaved).toEqual(['Shelf/Plans/garden.md']);
  });
});
