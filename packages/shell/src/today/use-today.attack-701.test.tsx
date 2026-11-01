// @vitest-environment jsdom
/**
 * Attack on PR #701 (#698), on Today: a row acted on settles on a read
 * stamped with the index's own key past where it stood as the write's
 * refresh was asked. These probe a read under way as the write lands, and
 * an undo whose refresh is asked after the index moved for another file.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  createVaultPath,
  REVIEW_PROJECTS_QUERY_MARK,
  REVIEW_TASKS_QUERY_MARK,
  type ObjectType,
} from '@dfai/domain';
import {
  fakeIndexPort,
  fakeVaultFs,
  memoryVault,
  recordingActivity,
  type QueryResult,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useToday } from './use-today.ts';

const NOW = Date.UTC(2026, 9, 13, 15);
const CLOCK = { today: () => '2026-10-13', now: () => NOW };
const PATH = createVaultPath('Tasks/Write the guide.md');
const ROW = { path: PATH, title: 'Write the guide' };
const TASK_TEXT = '---\ntype: task\nstatus: next-action\ndue: 2026-10-13\n---\n\n# Write\n';
const TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

/** The index: what it holds of the task, its key now, and a read the test holds. */
interface Index {
  status: string;
  key: string;
  reads: number;
  hold: Promise<void> | null;
}

async function answer(index: Index, sql: string): Promise<QueryResult> {
  if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
    index.reads += 1;
    // Read as the index stands when the read is asked, answered once the test lets it go.
    const status = index.status;
    if (index.hold !== null) await index.hold;
    return {
      columns: ['path', 'title', 'modified', 'status', 'due', 'defer'],
      rows: [[PATH, 'Write the guide', NOW, status, '2026-10-13', null]],
      truncated: false,
    };
  }
  if (sql.startsWith(REVIEW_PROJECTS_QUERY_MARK)) {
    return { columns: ['path', 'title', 'status', 'moving'], rows: [], truncated: false };
  }
  return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
}

function setUp({ strict = false }: { strict?: boolean } = {}) {
  const memory = memoryVault({ [PATH]: TASK_TEXT });
  const index: Index = { status: 'next-action', key: 'ready:1', reads: 0, hold: null };
  /** A write the test holds: it lands once the test lets it go. */
  const writes: { hold: Promise<void> | null } = { hold: null };
  const writeTextFile = memory.fs.writeTextFile ?? expect.fail('no write');
  const ports = {
    index: fakeIndexPort({ query: async (sql: string) => answer(index, sql) }),
    fs: fakeVaultFs({
      ...memory.fs,
      writeTextFile: async (...args: Parameters<typeof writeTextFile>) => {
        if (writes.hold !== null) await writes.hold;
        return writeTextFile(...args);
      },
    }),
    markdown: remarkMarkdown,
  };
  const activity = recordingActivity();
  const hook = renderHook(
    ({ indexKey }: { indexKey: string }) =>
      useToday({
        ports,
        editors: noPane,
        activity,
        clock: CLOCK,
        types: TYPES,
        vaultKey: 'vault-a',
        indexKey,
        indexKeyNow: () => index.key,
        open: true,
        onSettled: () => {},
      }),
    { initialProps: { indexKey: 'ready:1' }, reactStrictMode: strict },
  );
  const listed = () =>
    hook.result.current.page.today?.sections
      .flatMap((section) => section.groups)
      .flatMap((group) => group.tasks)
      .some((task) => task.path === PATH) ?? false;
  /** Holds the next reads until the returned function lets them go. */
  const holdReads = () => {
    let release = () => {};
    index.hold = new Promise<void>((resolve) => (release = resolve));
    return () => {
      index.hold = null;
      release();
    };
  };
  /** Holds the next writes until the returned function lets them go. */
  const holdWrites = () => {
    let release = () => {};
    writes.hold = new Promise<void>((resolve) => (release = resolve));
    return () => {
      writes.hold = null;
      release();
    };
  };
  return { ...hook, index, listed, holdReads, holdWrites };
}

describe('useToday — attack #701', () => {
  it('probe: a read begun before the write landed and answered after does not put the row back', async () => {
    const { result, rerender, index, listed, holdReads } = setUp();
    await waitFor(() => expect(listed()).toBe(true));

    // News of another file's refresh: a read begins, of the vault before the write, and is held.
    const release = holdReads();
    index.key = 'ready:2';
    const readsBefore = index.reads;
    rerender({ indexKey: 'ready:2' });
    await waitFor(() => expect(index.reads).toBe(readsBefore + 1));

    // A third refresh moves the index again before the write lands: the held read's key is
    // then not the one the write lands at, so only its having begun first keeps it behind.
    index.key = 'ready:3';
    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'someday' }));
    expect(listed()).toBe(false);

    await act(async () => release());
    await act(async () => {});
    expect(listed()).toBe(false);
    expect(result.current.page.settling.has(PATH)).toBe(true);
  });

  it('probe: an undo whose index moved while it was written is not taken as listed again on that news', async () => {
    const { result, rerender, index, listed, holdWrites } = setUp();
    await waitFor(() => expect(listed()).toBe(true));
    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'someday' }));
    index.status = 'someday';
    index.key = 'ready:2';
    rerender({ indexKey: 'ready:2' });
    await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(false));
    expect(listed()).toBe(false);

    // The undo begins; while it is written, another file's refresh — read with the task still
    // someday — moves the index.
    const release = holdWrites();
    let taken: string | null | undefined;
    await act(async () => {
      void result.current.page.onUndo().then((path) => (taken = path));
    });
    index.key = 'ready:3';
    await act(async () => release());
    await act(async () => {});
    // Its news reaches the page after the undo landed: the read lacks the task, and the
    // keyboard's undo must still wait for the row to be listed again.
    rerender({ indexKey: 'ready:3' });
    await act(async () => {});
    expect(listed()).toBe(false);
    expect(taken).toBeUndefined();

    // The undo's own refresh runs: the task is back, listed, and the undo settles to its row.
    index.status = 'next-action';
    index.key = 'ready:4';
    rerender({ indexKey: 'ready:4' });
    await waitFor(() => expect(taken).toBe(PATH));
    expect(listed()).toBe(true);
  });

  it('probe: under StrictMode a row holds through late news and settles on its own refresh', async () => {
    const { result, rerender, index, listed } = setUp({ strict: true });
    await waitFor(() => expect(listed()).toBe(true));
    index.key = 'ready:2';
    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'someday' }));
    rerender({ indexKey: 'ready:2' });
    await act(async () => {});
    expect(listed()).toBe(false);
    expect(result.current.page.settling.has(PATH)).toBe(true);
    index.status = 'someday';
    index.key = 'ready:3';
    rerender({ indexKey: 'ready:3' });
    await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(false));
    expect(listed()).toBe(false);
  });
});
