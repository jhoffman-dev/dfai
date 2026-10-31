// @vitest-environment jsdom
/**
 * The sidebar's catalogue is read again for what changed it, not for every
 * move of the index (#293): an autosave or a tick in a note outside `.atlas`
 * walked `.atlas` and read every note in it again.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { TYPE_COUNTS_QUERY_MARK, type ObjectType } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, readsTouchedByPaths } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { createReadInvalidator } from '../reads/read-invalidator.ts';
import { useSidebarCatalog } from './use-sidebar-catalog.ts';

const BOARD = '.atlas/views/Board.md';
const BOARD_NOTE = ['---', 'atlas: view', 'type: task', '---', '', '# Board', ''].join('\n');
const PLANNER = '.atlas/views/Planner.md';
const PLANNER_NOTE = ['---', 'atlas: view', 'type: task', '---', '', '# Planner', ''].join('\n');
const TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];
const NO_NOTES: readonly string[] = [];

function countingVault() {
  const files = new Map([[BOARD, BOARD_NOTE]]);
  const listed = vi.fn(async (folder: string) =>
    folder === '.atlas'
      ? [{ kind: 'directory' as const, name: 'views', path: '.atlas/views' }]
      : folder === '.atlas/views'
        ? [...files.keys()].map((path) => ({
            kind: 'file' as const,
            name: path.slice('.atlas/views/'.length),
            path,
          }))
        : [],
  );
  const read = vi.fn(async (paths: readonly string[]) =>
    paths.flatMap((path) => {
      const text = files.get(path);
      return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
    }),
  );
  const fs = fakeVaultFs({ listDirectory: listed as never, readNotes: read });
  const tasks = { count: 2 };
  const query = vi.fn(async (sql: string) =>
    sql.startsWith(TYPE_COUNTS_QUERY_MARK)
      ? { columns: ['type', 'count'], rows: [['task', tasks.count]], truncated: false }
      : { columns: [], rows: [], truncated: false },
  );
  const index = fakeIndexPort({ query });
  const counts = () => query.mock.calls.filter(([sql]) => sql.startsWith(TYPE_COUNTS_QUERY_MARK));
  return {
    fs,
    index,
    listed,
    read,
    tasks,
    counts,
    add: (path: string, text: string) => files.set(path, text),
  };
}

const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
};

function renderCatalog(ports: ReturnType<typeof countingVault>) {
  const { wrapper, client } = queryWrapper();
  const reads = createReadInvalidator({ client });
  const hook = renderHook(
    () =>
      useSidebarCatalog({
        fs: ports.fs,
        markdown: remarkMarkdown,
        index: ports.index,
        types: TYPES,
        notePaths: NO_NOTES,
        vaultKey: 'v',
        indexReady: true,
      }),
    { wrapper },
  );
  return { hook, reads };
}

const viewPaths = (hook: ReturnType<typeof renderCatalog>['hook']) =>
  hook.result.current.catalog.views.map((view) => view.path);

describe('useSidebarCatalog: what is read again', () => {
  it('does not walk .atlas again when the index moves for a note outside it', async () => {
    const ports = countingVault();
    const { hook, reads } = renderCatalog(ports);
    await waitFor(() => expect(viewPaths(hook)).toEqual([BOARD]));
    await settle();
    const [walks, read] = [ports.listed.mock.calls.length, ports.read.mock.calls.length];
    const { catalog, sidebarTypes } = hook.result.current;

    // An autosave or a tick: its path, and the index's news once it has taken the note in.
    reads.invalidate('v', readsTouchedByPaths(['Projects/DFAI.md']));
    reads.indexMoved('v');
    await settle();

    expect(ports.listed.mock.calls.length - walks).toBe(0);
    expect(ports.read.mock.calls.length - read).toBe(0);
    // The marks were asked again, and answered the same: the catalogue is the same object.
    expect(hook.result.current.catalog).toBe(catalog);
    expect(hook.result.current.sidebarTypes).toBe(sidebarTypes);
  });

  it('counts the types again on the index’s news, though no write changed the graph', async () => {
    const ports = countingVault();
    const { hook, reads } = renderCatalog(ports);
    await waitFor(() => expect(hook.result.current.sidebarTypes[0]?.count).toBe(2));
    await settle();
    const before = ports.counts().length;

    // A project restored from the archive: its `para` changed, not its `type`, and
    // the count leaves archived projects out — the graph facet cannot tell (#293).
    ports.tasks.count = 3;
    reads.indexMoved('v');

    await waitFor(() => expect(hook.result.current.sidebarTypes[0]?.count).toBe(3));
    expect(ports.counts().length - before).toBe(1);
  });

  it('walks .atlas again for a view another program adds there, and lists it', async () => {
    const ports = countingVault();
    const { hook, reads } = renderCatalog(ports);
    await waitFor(() => expect(viewPaths(hook)).toEqual([BOARD]));

    ports.add(PLANNER, PLANNER_NOTE);
    reads.invalidate('v', readsTouchedByPaths([PLANNER]));

    await waitFor(() => expect(viewPaths(hook)).toEqual([BOARD, PLANNER]));
  });
});
