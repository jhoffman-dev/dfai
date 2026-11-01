// @vitest-environment jsdom
/**
 * Adversarial probes of a batch keeping its rows chosen while it runs (#201,
 * PR #279): choosing and Shift-clicking meanwhile, two batches, a batch that
 * throws, and the view or search changing before the batch is answered.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  createVaultPath,
  parentVaultPath,
  vaultPathName,
  type VaultEntry,
  type VaultPath,
} from '@dfai/domain';
import {
  fakeIndexPort,
  fakeVaultFs,
  type ArchiveOutcome,
  type ArchivePorts,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import {
  useArchive,
  useArchivePage,
  type ArchiveCommands,
  type ArchiveOptions,
} from './use-archive.ts';
import { useRowSelection } from './use-row-selection.ts';
import { useViewChoosing } from './use-view-choosing.ts';

const path = (raw: string): VaultPath => createVaultPath(raw);

const settled = (failed: readonly string[] = []): ArchiveOutcome => ({
  moves: [],
  failed: failed.map((at) => ({ path: at as VaultPath, reason: 'locked' })),
  linksUpdated: 0,
});

/** A promise and the hand that answers it, so a test says when a batch settles. */
function held<T>() {
  let answer: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => (answer = resolve));
  return { promise, answer };
}

function archiveSetUp(notes: Record<string, string>, overrides: Partial<ArchiveOptions> = {}) {
  const files = new Map(Object.entries(notes));
  const dirs = new Set<string>(
    [...files.keys()].flatMap((at) => {
      const parent = parentVaultPath(path(at));
      return parent === '' ? [] : [parent];
    }),
  );
  const entry = (at: string, kind: VaultEntry['kind']) =>
    ({ kind, name: vaultPathName(path(at)), path: path(at) }) as VaultEntry;
  const fs = fakeVaultFs({
    listDirectory: async (parent) => [
      ...[...dirs]
        .filter((at) => parentVaultPath(path(at)) === parent)
        .map((at) => entry(at, 'directory')),
      ...[...files.keys()]
        .filter((at) => parentVaultPath(path(at)) === parent)
        .map((at) => entry(at, 'file')),
    ],
    createFolder: async ({ path: at }) => void dirs.add(at),
    moveEntry: async (move) => {
      const text = files.get(move.from);
      if (text === undefined) throw new Error('no such entry');
      files.delete(move.from);
      files.set(move.to, text);
    },
    readTextFile: async (at) => ({ text: files.get(at) ?? '', modified: 1 }),
    readNotes: async (paths) =>
      paths.flatMap((at) => {
        const text = files.get(at);
        return text === undefined ? [] : [{ path: at, text, modified: 1, size: text.length }];
      }),
    writeTextFile: async ({ path: at, contents }) => {
      files.set(at, contents);
      return 2;
    },
  });
  const ports: ArchivePorts = {
    fs,
    index: fakeIndexPort({
      query: async () => ({ columns: ['path'], rows: [], truncated: false }),
    }),
    markdown: remarkMarkdown,
    editors: {
      state: () => 'closed',
      flush: async () => {},
      follow: () => {},
      abandon: () => {},
      reload: () => {},
    },
  };
  const options: ArchiveOptions = {
    ports,
    clock: { today: () => '2026-09-27' },
    notePaths: Object.keys(notes).map(path),
    indexKey: '1',
    open: false,
    onSettled: vi.fn(),
    offerLinks: vi.fn(async () => {}),
    ...overrides,
  };
  const hook = renderHook(
    (props: ArchiveOptions) => {
      const { commands, notice } = useArchive(props);
      const page = useArchivePage({
        ports: props.ports,
        indexKey: props.indexKey,
        open: props.open,
        commands,
      });
      return { commands, notice, page };
    },
    { initialProps: options },
  );
  return { fs, files, hook, options };
}

/** Holds every move until `release`, so a test can act while the batch runs. */
function gateMoves(fs: ArchivePorts['fs']) {
  const gate = held<void>();
  const move = fs.moveEntry.bind(fs);
  vi.spyOn(fs, 'moveEntry').mockImplementation(async (entry) => {
    await gate.promise;
    return move(entry);
  });
  return () => gate.answer();
}

function viewSetUp() {
  const commands: ArchiveCommands = {
    archive: vi.fn(async () => settled()),
    unarchive: vi.fn(async () => settled()),
    busy: false,
  };
  const hook = renderHook((viewKey: string) => useViewChoosing({ viewKey, commands }), {
    initialProps: '.atlas/views/Tasks.md',
  });
  return { commands, hook };
}

const ORDER = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];

describe('a batch keeping its rows chosen while it runs (#201, attack)', () => {
  it('a Shift-click after the batch starts its run from a row still in the list, not one it removed', () => {
    const { result } = renderHook(() => useRowSelection('list'));
    act(() => {
      result.current.selection.onToggle('a.md');
      result.current.selection.onToggle('b.md');
    });
    // While the batch on a and b runs, c is chosen on its own: the anchor.
    act(() => result.current.selection.onToggle('c.md'));
    act(() => result.current.afterBatch({ answered: ['a.md', 'b.md'], failed: [] }));
    const order = ORDER.filter((row) => row !== 'a.md' && row !== 'b.md');
    act(() => result.current.selection.onToggle('e.md', { order }));
    expect([...result.current.selection.selected].sort()).toEqual(['c.md', 'd.md', 'e.md']);
  });

  it('a Shift-click after the batch removed the anchor chooses its own row alone', () => {
    const { result } = renderHook(() => useRowSelection('list'));
    act(() => {
      result.current.selection.onToggle('d.md');
      result.current.selection.onToggle('b.md');
    });
    // During the batch, b is Shift-extended to c: the anchor stays b, which then goes.
    act(() => result.current.selection.onToggle('c.md', { order: ORDER }));
    act(() => result.current.afterBatch({ answered: ['d.md', 'b.md'], failed: [] }));
    const order = ORDER.filter((row) => row !== 'b.md' && row !== 'd.md');
    act(() => result.current.selection.onToggle('e.md', { order }));
    expect([...result.current.selection.selected].sort()).toEqual(['c.md', 'e.md']);
  });

  it('a row let go of while the batch runs, which then goes, stays let go of', () => {
    const { result } = renderHook(() => useRowSelection('list'));
    act(() => {
      result.current.selection.onToggle('a.md');
      result.current.selection.onToggle('b.md');
    });
    act(() => result.current.selection.onToggle('a.md'));
    act(() => result.current.afterBatch({ answered: ['a.md', 'b.md'], failed: [] }));
    expect(result.current.chosen).toEqual([]);
  });

  it('a row that left the list in a batch can be chosen again once it is back', () => {
    const { result } = renderHook(() => useRowSelection('list'));
    act(() => result.current.selection.onToggle('a.md'));
    act(() => result.current.afterBatch({ answered: ['a.md'], failed: [] }));
    expect(result.current.chosen).toEqual([]);
    act(() => result.current.selection.onToggle('a.md'));
    expect(result.current.chosen).toEqual(['a.md']);
    act(() => result.current.selection.onToggle('c.md', { order: ORDER }));
    expect([...result.current.selection.selected].sort()).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('a second press while the Archive’s batch runs leaves the choice to the first batch', async () => {
    const { fs, files, hook } = archiveSetUp({
      'Archive/a.md': '---\narchivedFrom: a.md\n---\n',
      'b.md': '',
    });
    const release = gateMoves(fs);
    act(() => {
      hook.result.current.page.choosing.selection.onToggle('Archive/a.md');
      hook.result.current.page.choosing.selection.onToggle('b.md');
    });
    act(() => hook.result.current.page.unarchive([path('Archive/a.md'), path('b.md')]));
    await act(async () => hook.result.current.page.unarchive([path('Archive/a.md'), path('b.md')]));
    expect(hook.result.current.page.choosing.chosen).toHaveLength(2);
    await act(async () => release());
    await waitFor(() => expect(files.has('a.md')).toBe(true));
    await waitFor(() => expect(hook.result.current.page.choosing.chosen).toEqual(['b.md']));
  });

  it('a batch whose move throws keeps only the row that could not go chosen', async () => {
    const { fs, hook } = archiveSetUp({
      'Archive/a.md': '---\narchivedFrom: a.md\n---\n',
      'Archive/b.md': '---\narchivedFrom: b.md\n---\n',
    });
    const move = fs.moveEntry.bind(fs);
    vi.spyOn(fs, 'moveEntry').mockImplementation(async (entry) => {
      if (entry.from === 'Archive/b.md') throw new Error('disk gone');
      return move(entry);
    });
    act(() => {
      hook.result.current.page.choosing.selection.onToggle('Archive/a.md');
      hook.result.current.page.choosing.selection.onToggle('Archive/b.md');
    });
    act(() => hook.result.current.page.unarchive([path('Archive/a.md'), path('Archive/b.md')]));
    await waitFor(() => expect(hook.result.current.commands.busy).toBe(false));
    expect(hook.result.current.page.choosing.chosen).toEqual(['Archive/b.md']);
  });

  it('a single note that went back is not left chosen when its link offer then fails', async () => {
    const offerLinks = vi.fn(async () => {
      throw new Error('index unavailable');
    });
    const { files, hook } = archiveSetUp(
      { 'Archive/a.md': '---\narchivedFrom: a.md\n---\n' },
      { offerLinks },
    );
    act(() => hook.result.current.page.choosing.selection.onToggle('Archive/a.md'));
    act(() => hook.result.current.page.unarchive([path('Archive/a.md')]));
    await waitFor(() => expect(hook.result.current.commands.busy).toBe(false));
    expect(files.has('a.md')).toBe(true);
    // The row has left the Archive; chosen, it would offer to unarchive a note that is not there.
    expect(hook.result.current.page.choosing.chosen).toEqual([]);
  });

  it('a search typed while the Archive’s batch runs is not handed the rows that failed before it', async () => {
    const { fs, hook } = archiveSetUp({
      'Archive/a.md': '---\narchivedFrom: a.md\n---\n',
      'b.md': '',
    });
    const release = gateMoves(fs);
    act(() => {
      hook.result.current.page.choosing.selection.onToggle('Archive/a.md');
      hook.result.current.page.choosing.selection.onToggle('b.md');
    });
    act(() => hook.result.current.page.unarchive([path('Archive/a.md'), path('b.md')]));
    act(() => hook.result.current.page.setSearch('zzz'));
    expect(hook.result.current.page.choosing.chosen).toEqual([]);

    await act(async () => release());
    await waitFor(() => expect(hook.result.current.commands.busy).toBe(false));
    // b failed under the old search; under the new one nobody chose it, nor can see it.
    expect(hook.result.current.page.choosing.chosen).toEqual([]);
  });

  it('a view changed while its batch runs is not handed the rows that failed in the old one', async () => {
    const { commands, hook } = viewSetUp();
    const batch = held<ArchiveOutcome>();
    vi.mocked(commands.archive).mockReturnValue(batch.promise);
    act(() => hook.result.current.setOn(true));
    act(() => {
      hook.result.current.selection.onToggle('tasks/a.md');
      hook.result.current.selection.onToggle('tasks/b.md');
    });
    act(() => hook.result.current.actions[0]?.onRun());
    hook.rerender('.atlas/views/Other.md');
    expect(hook.result.current.count).toBe(0);

    await act(async () => batch.answer(settled(['tasks/b.md'])));
    expect(hook.result.current.on).toBe(false);
    expect(hook.result.current.count).toBe(0);
  });

  it('select mode turned off while its batch runs stays with nothing chosen', async () => {
    const { commands, hook } = viewSetUp();
    const batch = held<ArchiveOutcome>();
    vi.mocked(commands.archive).mockReturnValue(batch.promise);
    act(() => hook.result.current.setOn(true));
    act(() => hook.result.current.selection.onToggle('tasks/a.md'));
    act(() => hook.result.current.actions[0]?.onRun());
    act(() => hook.result.current.setOn(false));

    await act(async () => batch.answer(settled(['tasks/a.md'])));
    expect(hook.result.current.count).toBe(0);
    expect(hook.result.current.actions).toEqual([]);
  });
});
