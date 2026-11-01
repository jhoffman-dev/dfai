// @vitest-environment jsdom
/**
 * #698: a row acted on settles only on a read of the index as it stood once
 * the refresh its write asked for could have run. The news of an index that
 * moved a moment before the write landed — another file's refresh, read
 * before this write — reaches the page a little later, and a read begun on
 * it is still of the vault from before the write: drawing it put the row
 * back for a beat, and the key pressed in that beat landed on it.
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

/** The index: what it holds of the task, the key it is at now, and the reads asked of it. */
interface Index {
  status: string;
  key: string;
  reads: number;
}

function answer(index: Index, sql: string): QueryResult {
  if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
    index.reads += 1;
    return {
      columns: ['path', 'title', 'modified', 'status', 'due', 'defer'],
      rows: [[PATH, 'Write the guide', NOW, index.status, '2026-10-13', null]],
      truncated: false,
    };
  }
  if (sql.startsWith(REVIEW_PROJECTS_QUERY_MARK)) {
    return { columns: ['path', 'title', 'status', 'moving'], rows: [], truncated: false };
  }
  return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
}

function setUp() {
  const memory = memoryVault({ [PATH]: TASK_TEXT });
  const index: Index = { status: 'next-action', key: 'ready:1', reads: 0 };
  const ports = {
    index: fakeIndexPort({ query: async (sql: string) => answer(index, sql) }),
    fs: fakeVaultFs(memory.fs),
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
        // The page's key: the index's news, which reaches it a little after the index moves.
        indexKey,
        // The index's own key, as it is the moment it is asked.
        indexKeyNow: () => index.key,
        open: true,
        // The refresh each write asks for: it runs when the test says.
        onSettled: () => {},
      }),
    { initialProps: { indexKey: 'ready:1' } },
  );
  const listed = () =>
    hook.result.current.page.today?.sections
      .flatMap((section) => section.groups)
      .flatMap((group) => group.tasks)
      .some((task) => task.path === PATH) ?? false;
  return { ...hook, index, listed };
}

describe('useToday — settling on news that comes late (#698)', () => {
  it('keeps a row off the page through a read of an index that moved before its write landed', async () => {
    const { result, rerender, index, listed } = setUp();
    await waitFor(() => expect(listed()).toBe(true));

    // Another file's refresh, which read the vault before this write, has moved the index;
    // its news has not reached the page yet.
    index.key = 'ready:2';
    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'someday' }));
    expect(listed()).toBe(false);

    // The news arrives once the write has landed: the read it begins is of the index from before it.
    const readsBefore = index.reads;
    rerender({ indexKey: 'ready:2' });
    await waitFor(() => expect(index.reads).toBe(readsBefore + 1));
    await act(async () => {});
    expect(listed()).toBe(false);
    expect(result.current.page.settling.has(PATH)).toBe(true);

    // The write's own refresh runs: the index has it, moves, and the row settles off the page.
    index.status = 'someday';
    index.key = 'ready:3';
    rerender({ indexKey: 'ready:3' });
    await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(false));
    expect(listed()).toBe(false);
  });

  it('control: settles on the first read of an index that moved after the write landed', async () => {
    const { result, rerender, index, listed } = setUp();
    await waitFor(() => expect(listed()).toBe(true));
    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'someday' }));
    index.status = 'someday';
    index.key = 'ready:2';
    rerender({ indexKey: 'ready:2' });
    await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(false));
    expect(listed()).toBe(false);
  });
});
