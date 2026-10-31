import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  unsavedThroughLinkRefusal,
  type EntryMove,
  type VaultEntry,
} from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs } from '../testing/fake-ports.ts';
import { VaultAccessError, type OpenEditorsPort } from './ports.ts';
import { moveEntryInto, MoveRefusedError } from './relocate-entry.ts';

/*
 * Second attack on PR #684: the hold on a move while a pane types in a note
 * open by way of a link. `it.fails` marks a finding: the hold does not hold.
 *
 * `Work/Alias -> Shelf` is a folder link; `Work/alias.md -> ../Shelf/Plans/garden.md`
 * is a note that is itself a link; `Play/Hop -> ../Work/Alias` is a link to a link.
 */

const path = (raw: string) => createVaultPath(raw);
const dir = (at: string, link = false): VaultEntry => ({
  kind: 'directory',
  name: at.split('/').at(-1) ?? '',
  path: path(at),
  ...(link && { link: true as const }),
});
const file = (at: string, link = false): VaultEntry => ({
  kind: 'file',
  name: at.split('/').at(-1) ?? '',
  path: path(at),
  ...(link && { link: true as const }),
});
const folder = (at: string) => ({ path: path(at), kind: 'directory' as const });

const listings: Record<string, VaultEntry[]> = {
  '': [dir('Work'), dir('Shelf'), dir('Play')],
  Work: [dir('Work/Alias', true), file('Work/alias.md', true)],
  'Work/Alias': [dir('Work/Alias/Plans')],
  'Work/Alias/Plans': [file('Work/Alias/Plans/garden.md')],
  Shelf: [dir('Shelf/Plans')],
  'Shelf/Plans': [file('Shelf/Plans/garden.md')],
  Play: [dir('Play/Hop', true)],
  'Play/Hop': [dir('Play/Hop/Plans')],
  'Play/Hop/Plans': [file('Play/Hop/Plans/garden.md')],
};
const notePaths = [
  'Work/alias.md',
  'Work/Alias/Plans/garden.md',
  'Shelf/Plans/garden.md',
  'Play/Hop/Plans/garden.md',
].map(path);

/** The host as `listings` describes it; `typing` says which panes are dirty, asked each time. */
function host(typing: () => readonly string[]) {
  const log: string[] = [];
  const fs = fakeVaultFs({
    listDirectory: async (at) => {
      const entries = listings[at];
      if (entries === undefined) throw new VaultAccessError('no such folder');
      return entries;
    },
    moveEntry: async (move) => {
      log.push(`move ${move.from} -> ${move.to}`);
    },
  });
  const editors: OpenEditorsPort = {
    state: (at) => (typing().includes(at) ? 'dirty' : 'closed'),
    flush: async (paths) => {
      log.push(...paths.map((at) => `flush ${at}`));
    },
    follow: (move: EntryMove) => log.push(`follow ${move.from} -> ${move.to}`),
    abandon: () => {},
  };
  return { ports: { fs, index: fakeIndexPort(), editors }, log };
}

describe('the hold on a move while a pane types by way of a link (PR #684, attack 2)', () => {
  /*
   * `Work/alias.md` is a link to `Shelf/Plans/garden.md`. No folder above it is
   * a link, so `linkAbove` finds nothing, and the move of `Shelf/Plans` goes
   * ahead while the pane types in the moving note under another path: its
   * typing is saved to `Work/alias.md`, which then points at nothing.
   */
  it.fails('holds while a pane types in a note that is itself a link', async () => {
    const { ports, log } = host(() => ['Work/alias.md']);

    const moving = moveEntryInto({
      ports,
      entry: folder('Shelf/Plans'),
      folder: path('Play'),
      notePaths,
    });

    await expect(moving).rejects.toThrow(MoveRefusedError);
    expect(log).toEqual([]);
  });

  /*
   * The panes are looked at once, before the carried ones are saved. A pane on
   * `Work/Alias/Plans/garden.md` that starts typing while that save is on its
   * way is not looked at again, and the host moves `Shelf/Plans` under it.
   */
  it.fails('holds when typing by way of a link starts before the host moves', async () => {
    let flushed = false;
    const { ports, log } = host(() => (flushed ? ['Work/Alias/Plans/garden.md'] : []));
    const flush = ports.editors.flush;
    ports.editors.flush = async (paths) => {
      await flush(paths);
      flushed = true;
    };

    const moving = moveEntryInto({
      ports,
      entry: folder('Shelf/Plans'),
      folder: path('Play'),
      notePaths,
    });

    await expect(moving).rejects.toThrow(MoveRefusedError);
    expect(log).not.toContain('move Shelf/Plans -> Play/Plans');
  });

  it('holds while a pane types by way of a link to a link', async () => {
    const { ports, log } = host(() => ['Play/Hop/Plans/garden.md']);

    const moving = moveEntryInto({
      ports,
      entry: folder('Shelf/Plans'),
      folder: path('Work'),
      notePaths,
    });

    await expect(moving).rejects.toThrow(
      new MoveRefusedError(
        unsavedThroughLinkRefusal(path('Play/Hop/Plans/garden.md'), path('Play/Hop')),
      ),
    );
    expect(log).toEqual([]);
  });

  it('holds while panes type on both the real path and the link path of what moves', async () => {
    const { ports, log } = host(() => ['Shelf/Plans/garden.md', 'Work/Alias/Plans/garden.md']);

    const moving = moveEntryInto({
      ports,
      entry: folder('Shelf/Plans'),
      folder: path('Play'),
      notePaths,
    });

    await expect(moving).rejects.toThrow(
      new MoveRefusedError(
        unsavedThroughLinkRefusal(path('Work/Alias/Plans/garden.md'), path('Work/Alias')),
      ),
    );
    expect(log).toEqual([]);
  });

  it('asks the host nothing more when no pane is typing', async () => {
    const { ports, log } = host(() => []);
    let listed = 0;
    const list = ports.fs.listDirectory;
    ports.fs.listDirectory = async (at) => {
      listed += 1;
      return list(at);
    };

    await moveEntryInto({ ports, entry: folder('Shelf/Plans'), folder: path('Play'), notePaths });

    expect(log).toContain('move Shelf/Plans -> Play/Plans');
    // The root twice, to see whether `Shelf` and `Play` are links: no pane's folders.
    expect(listed).toBe(2);
  });
});
