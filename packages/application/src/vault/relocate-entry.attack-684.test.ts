import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  unsavedThroughLinkRefusal,
  type EntryMove,
  type VaultEntry,
} from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs } from '../testing/fake-ports.ts';
import { VaultAccessError, type OpenEditorsPort } from './ports.ts';
import { moveEntryInto, renameEntry, MoveRefusedError } from './relocate-entry.ts';

/*
 * Attack on PR #684 (#680). `Work/Alias -> Shelf`: the host lists the same
 * notes under `Work/Alias/...` and `Shelf/...`, and a pane may be open on
 * either path.
 */

const path = (raw: string) => createVaultPath(raw);
const dir = (at: string, link = false): VaultEntry => ({
  kind: 'directory',
  name: at.split('/').at(-1) ?? '',
  path: path(at),
  ...(link && { link: true as const }),
});
const file = (at: string): VaultEntry => ({
  kind: 'file',
  name: at.split('/').at(-1) ?? '',
  path: path(at),
});
const folder = (at: string) => ({ path: path(at), kind: 'directory' as const });

const listings: Record<string, VaultEntry[]> = {
  '': [dir('Work'), dir('Shelf'), dir('Play')],
  Work: [dir('Work/Alias', true)],
  'Work/Alias': [dir('Work/Alias/Plans')],
  'Work/Alias/Plans': [dir('Work/Alias/Plans/Deep')],
  'Work/Alias/Plans/Deep': [file('Work/Alias/Plans/Deep/garden.md')],
  Shelf: [dir('Shelf/Plans')],
  'Shelf/Plans': [dir('Shelf/Plans/Deep')],
  'Shelf/Plans/Deep': [file('Shelf/Plans/Deep/garden.md')],
  Play: [],
};
const notePaths = ['Work/Alias/Plans/Deep/garden.md', 'Shelf/Plans/Deep/garden.md'].map(path);

function host(unreadable: readonly string[] = []) {
  const log: string[] = [];
  const fs = fakeVaultFs({
    listDirectory: async (at) => {
      if (unreadable.includes(at)) throw new VaultAccessError('cannot read the folder');
      const entries = listings[at];
      if (entries === undefined) throw new VaultAccessError('no such folder');
      return entries;
    },
    moveEntry: async (move) => {
      log.push(`move ${move.from} -> ${move.to}`);
    },
  });
  const editors: OpenEditorsPort = {
    state: () => 'dirty',
    flush: async (paths) => {
      log.push(...paths.map((at) => `flush ${at}`));
    },
    follow: (move: EntryMove) => log.push(`follow ${move.from} -> ${move.to}`),
    abandon: () => {},
  };
  return { ports: { fs, index: fakeIndexPort(), editors }, log };
}

describe('attack #684: the real folder behind a link', () => {
  // Moving the real `Shelf/Plans` is allowed, and is the advice the refusal
  // gives ("do it where it really is"). But a pane may be typing in the same
  // note by its link path, `Work/Alias/Plans/Deep/garden.md`. The app cannot
  // tell where a link points, so it cannot flush and follow that pane as the
  // moved note; the move is refused while it holds unsaved typing, before
  // anything is touched (decided on review of PR #684).
  it('refuses while a pane holds unsaved typing in a note open by way of a link', async () => {
    const { ports, log } = host();

    const moving = moveEntryInto({
      ports,
      entry: folder('Shelf/Plans'),
      folder: path('Play'),
      notePaths,
    });

    await expect(moving).rejects.toThrow(
      new MoveRefusedError(
        unsavedThroughLinkRefusal(path('Work/Alias/Plans/Deep/garden.md'), path('Work/Alias')),
      ),
    );
    expect(log).toEqual([]);
  });
});

describe('attack #684: probed and sound', () => {
  it('refuses a rename two folders under a link before any pane is flushed', async () => {
    const { ports, log } = host();

    await expect(
      renameEntry({ ports, entry: folder('Work/Alias/Plans/Deep'), name: 'Shallow', notePaths }),
    ).rejects.toBeInstanceOf(MoveRefusedError);
    expect(log).toEqual([]);
  });

  it('refuses a move into a folder two levels under a link before any pane is flushed', async () => {
    const { ports, log } = host();

    await expect(
      moveEntryInto({
        ports,
        entry: folder('Play'),
        folder: path('Work/Alias/Plans/Deep'),
        notePaths,
      }),
    ).rejects.toBeInstanceOf(MoveRefusedError);
    expect(log).toEqual([]);
  });

  it('moves nothing when a folder above cannot be listed for the link check', async () => {
    const { ports, log } = host(['Shelf']);

    await expect(
      renameEntry({ ports, entry: folder('Shelf/Plans/Deep'), name: 'Shallow', notePaths }),
    ).rejects.toBeInstanceOf(VaultAccessError);
    expect(log).toEqual([]);
  });
});
