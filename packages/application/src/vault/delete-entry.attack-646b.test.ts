import { describe, expect, it, vi } from 'vitest';
import { createVaultPath, type VaultEntry } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs } from '../testing/fake-ports.ts';
import { countOtherFiles, deleteEntry } from './delete-entry.ts';
import { VaultAccessError, type OpenEditorsPort } from './ports.ts';
import { MoveRefusedError } from './relocate-entry.ts';

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

/*
 * What the Trash would take through the link cannot be told from here — the
 * host does not say where a link points — so such a delete is refused, with
 * the link named, before anything is touched (#169, PR #646).
 */
describe('deleting a folder reached through a link (attack 646b)', () => {
  it('is not counted: the question names the link it is reached through', async () => {
    const counted = await countOtherFiles({ fs, entry: throughLink, notes: indexed });

    expect(counted).toEqual({ link: false, count: 0, links: [], reachedThrough: 'Work/Alias' });
  });

  it('is refused before the Trash, leaving every pane and its typing as it is', async () => {
    const trashEntry = vi.fn(async () => undefined);
    const abandon = vi.fn();
    const editors: OpenEditorsPort = {
      state: (path) => (path === indexed[0] ? 'dirty' : 'closed'),
      flush: async () => undefined,
      follow: () => undefined,
      abandon,
    };

    const deleting = deleteEntry({
      fs: { ...fs, trashEntry },
      index: fakeIndexPort(),
      editors,
      entry: throughLink,
      notePaths: indexed,
    });

    await expect(deleting).rejects.toThrow(MoveRefusedError);
    await expect(deleting).rejects.toThrow('“Work/Alias”');
    expect(trashEntry).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
  });

  it('is refused for a note reached through a link too', async () => {
    const trashEntry = vi.fn(async () => undefined);
    const note = { path: createVaultPath('Work/Alias/Plans/garden.md'), kind: 'file' as const };

    await expect(
      deleteEntry({
        fs: { ...fs, trashEntry },
        index: fakeIndexPort(),
        editors: {
          state: () => 'closed',
          flush: async () => undefined,
          follow: () => undefined,
          abandon: vi.fn(),
        },
        entry: note,
        notePaths: indexed,
      }),
    ).rejects.toThrow(MoveRefusedError);
    expect(trashEntry).not.toHaveBeenCalled();
  });
});
