// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, REVIEW_TASKS_QUERY_MARK, type ObjectType } from '@dfai/domain';
import {
  fakeIndexPort,
  fakeVaultFs,
  memoryVault,
  recordingActivity,
  type QueryResult,
} from '@dfai/application';
import type { OpenEditors } from '../panes/open-editors.ts';
import { remarkMarkdown } from '@dfai/adapters';
import { createTodayWrites } from './today-writes.ts';
import { useToday } from './use-today.ts';

/*
 * Today's writes in flight are the window's per vault (tab-model.md, PR B):
 * two tabs on Today — one switched back to, or one in each pane — see the
 * same task settling and keep the same undo.
 */

const NOW = Date.UTC(2026, 9, 13, 15);
const CLOCK = { today: () => '2026-10-13', now: () => NOW };
const PATH = createVaultPath('Tasks/Ship the page.md');
const ROW = { path: PATH, title: 'Ship the page' };
const TASK_TEXT = '---\ntype: task\nstatus: next-action\ndue: 2026-10-13\n---\n\n# Ship\n';
const TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

function answer(sql: string): QueryResult {
  if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
    return {
      columns: ['path', 'title', 'modified', 'status', 'due', 'defer'],
      rows: [[PATH, 'Ship the page', NOW, 'next-action', '2026-10-13', null]],
      truncated: false,
    };
  }
  return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
}

describe('useToday on a window-held set of writes', () => {
  it('a second tab on the same hold sees a task ticked in the first as settling, and keeps its undo', async () => {
    const memory = memoryVault({ [PATH]: TASK_TEXT });
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fs = fakeVaultFs({
      ...memory.fs,
      writeTextFile: async (args) => {
        await gate;
        return memory.fs.writeTextFile(args);
      },
    });
    const ports = {
      index: fakeIndexPort({ query: async (sql: string) => answer(sql) }),
      fs,
      markdown: remarkMarkdown,
    };
    const held = createTodayWrites();
    const mount = (own?: ReturnType<typeof createTodayWrites>) =>
      renderHook(() =>
        useToday({
          ports,
          editors: noPane,
          activity: recordingActivity(),
          clock: CLOCK,
          types: TYPES,
          vaultKey: 'vault-a',
          indexKey: '1',
          open: true,
          onSettled: vi.fn(),
          ...(own !== undefined && { held: own }),
        }),
      );
    const first = mount(held);
    await waitFor(() => expect(first.result.current.page.today).not.toBeNull());
    await act(async () => first.result.current.page.onDone(ROW));
    await waitFor(() => expect(first.result.current.page.settling.has(PATH)).toBe(true));

    // Mounted afresh on the same hold: the tick is still landing there too.
    const second = mount(held);
    await waitFor(() => expect(second.result.current.page.today).not.toBeNull());
    expect(second.result.current.page.settling.has(PATH)).toBe(true);
    // A tab with its own hold would offer the task as still to do.
    const alone = mount();
    await waitFor(() => expect(alone.result.current.page.today).not.toBeNull());
    expect(alone.result.current.page.settling.has(PATH)).toBe(false);

    release();
    await waitFor(() => expect(memory.files.get(PATH)).toContain('status: archive'));
    await waitFor(() => expect(first.result.current.notice?.title).toBe('Ship the page'));
    expect(second.result.current.notice?.title).toBe('Ship the page');
  });
});
