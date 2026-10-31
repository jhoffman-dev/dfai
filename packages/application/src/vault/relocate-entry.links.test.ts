import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  moveIntoLinkRefusal,
  moveThroughLinkRefusal,
  type EntryMove,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs } from '../testing/fake-ports.ts';
import { listVaultFolders } from './create-folder.ts';
import { VaultAccessError, type OpenEditorsPort } from './ports.ts';
import { moveEntryInto, renameEntry, MoveRefusedError } from './relocate-entry.ts';
import { linksToUpdate } from './update-links.ts';

/*
 * Moving or renaming an entry that is, holds, or is reached through a link
 * (#680, after PR #646). The host's listing marks links and follows the ones
 * that stay in the vault, so `Work/Alias -> Shelf` lists `Work/Alias/Plans`,
 * which is the real `Shelf/Plans`; a link out of the vault, `Projects/Out`,
 * cannot be listed at all.
 */

const ESCAPES = 'path escapes the vault';
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
const note = (at: string) => ({ path: path(at), kind: 'file' as const });

const listings: Record<string, VaultEntry[]> = {
  '': [dir('Work'), dir('Shelf'), dir('Play'), dir('Projects')],
  Work: [dir('Work/Alias', true), file('Work/todo.md')],
  'Work/Alias': [dir('Work/Alias/Plans')],
  'Work/Alias/Plans': [file('Work/Alias/Plans/garden.md')],
  Shelf: [dir('Shelf/Plans')],
  'Shelf/Plans': [file('Shelf/Plans/garden.md')],
  Play: [],
  Projects: [file('Projects/plan.md'), dir('Projects/Out', true)],
};
/** As the host walks them: an in-vault link's notes under both paths, none past a link out. */
const notePaths = [
  'Work/todo.md',
  'Work/Alias/Plans/garden.md',
  'Shelf/Plans/garden.md',
  'Projects/plan.md',
].map(path);

/** The host as `listings` describes it, recording what it is asked to do. */
function host() {
  const log: string[] = [];
  const fs = fakeVaultFs({
    listDirectory: async (at) => {
      if (at === 'Projects/Out' || at.startsWith('Projects/Out/')) {
        throw new VaultAccessError(ESCAPES);
      }
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

describe('a folder that is a link (#680)', () => {
  it('is renamed as the link, the panes on its notes following', async () => {
    const { ports, log } = host();

    const moved = await renameEntry({
      ports,
      entry: folder('Work/Alias'),
      name: 'Desk',
      notePaths,
    });

    expect(moved?.move).toEqual({ from: 'Work/Alias', to: 'Work/Desk' });
    expect(log).toEqual([
      'flush Work/Alias/Plans/garden.md',
      'move Work/Alias -> Work/Desk',
      'follow Work/Alias -> Work/Desk',
    ]);
  });

  it('is moved as the link into a real folder', async () => {
    const { ports, log } = host();

    await moveEntryInto({ ports, entry: folder('Work/Alias'), folder: path('Play'), notePaths });

    expect(log).toContain('move Work/Alias -> Play/Alias');
  });

  it('has the links naming it by path rewritten, and the real notes’ links left alone', async () => {
    const { fs } = host().ports;
    const texts: Record<string, string> = {
      'Work/todo.md': 'By path [[Work/Alias/Plans/garden]], really [[Shelf/Plans/garden]].\n',
    };
    const reading = {
      ...fs,
      readNotes: async (paths: readonly VaultPath[]) =>
        paths.map((at) => ({ path: at, text: texts[at] ?? '', modified: 1, size: 1 })),
    };

    const update = await linksToUpdate({
      fs: reading,
      move: { from: path('Work/Alias'), to: path('Work/Desk') },
      notePaths,
    });

    expect(update.notes).toEqual([{ path: 'Work/todo.md', count: 1 }]);
  });
});

describe('a real folder holding a link out of the vault (#680)', () => {
  it('moves whole in one move, without looking through the link', async () => {
    const { ports, log } = host();

    await moveEntryInto({ ports, entry: folder('Projects'), folder: path('Play'), notePaths });

    expect(log).toEqual([
      'flush Projects/plan.md',
      'move Projects -> Play/Projects',
      'follow Projects -> Play/Projects',
    ]);
  });
});

/*
 * `Work/Alias/Plans` is `Shelf/Plans`: moving or renaming it by the alias
 * would move the real folder, while the panes, the index and the links were
 * moved for a path that is not where anything went. Refused before anything
 * is touched — no pane is even saved — with the link named.
 */
describe('an entry reached through a link (#680)', () => {
  it('is not renamed', async () => {
    const { ports, log } = host();

    const renaming = renameEntry({
      ports,
      entry: folder('Work/Alias/Plans'),
      name: 'Beds',
      notePaths,
    });

    await expect(renaming).rejects.toThrow(
      new MoveRefusedError(moveThroughLinkRefusal(path('Work/Alias'))),
    );
    expect(log).toEqual([]);
  });

  it('is not renamed when it is a note', async () => {
    const { ports, log } = host();

    const renaming = renameEntry({
      ports,
      entry: note('Work/Alias/Plans/garden.md'),
      name: 'beds',
      notePaths,
    });

    await expect(renaming).rejects.toThrow(moveThroughLinkRefusal(path('Work/Alias')));
    expect(log).toEqual([]);
  });

  it('is not moved', async () => {
    const { ports, log } = host();

    const moving = moveEntryInto({
      ports,
      entry: note('Work/Alias/Plans/garden.md'),
      folder: path('Play'),
      notePaths,
    });

    await expect(moving).rejects.toThrow(moveThroughLinkRefusal(path('Work/Alias')));
    expect(log).toEqual([]);
  });
});

describe('a move into a link (#680)', () => {
  it('is refused into a folder that is a link', async () => {
    const { ports, log } = host();

    const moving = moveEntryInto({
      ports,
      entry: note('Work/todo.md'),
      folder: path('Work/Alias'),
      notePaths,
    });

    await expect(moving).rejects.toThrow(
      new MoveRefusedError(moveIntoLinkRefusal(path('Work/Alias'))),
    );
    expect(log).toEqual([]);
  });

  it('is refused into a folder reached through a link', async () => {
    const { ports, log } = host();

    const moving = moveEntryInto({
      ports,
      entry: note('Projects/plan.md'),
      folder: path('Work/Alias/Plans'),
      notePaths,
    });

    await expect(moving).rejects.toThrow(moveIntoLinkRefusal(path('Work/Alias')));
    expect(log).toEqual([]);
  });
});

describe('the folders a move can choose from, with links (#680)', () => {
  it('leaves out links and what is reached through them, and never lists through one', async () => {
    const { fs } = host().ports;

    const offered = await listVaultFolders({ fs });

    expect(offered).toEqual(['Play', 'Projects', 'Shelf', 'Shelf/Plans', 'Work']);
  });
});
