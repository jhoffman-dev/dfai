// @vitest-environment jsdom
/** P31-01: a task's page reads its schedule, and reads it again when the index changes. */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { fakeIndexPort, type DefinedType } from '@dfai/application';
import { createVaultPath, GTD_STATUS_PROPERTY } from '@dfai/domain';
import { useTaskSchedule } from './use-task-schedule.ts';

const REPORT = createVaultPath('tasks/Report.md');
const TYPES: readonly DefinedType[] = [
  {
    name: 'task',
    label: 'Task',
    properties: [GTD_STATUS_PROPERTY],
    path: createVaultPath('.atlas/types/task.md'),
  },
];

/** An index holding the report, estimated at 2h, and one block for it of `blockMinutes`. */
function indexWith(blockMinutes: () => number) {
  const query = vi.fn(async (sql: string) => {
    if (!sql.includes('AS "block"')) {
      return {
        columns: ['path', 'estimate', 'finished'],
        rows: [[REPORT, '120', 0]],
        truncated: false,
      };
    }
    const end = `2026-10-12T${String(9 + blockMinutes() / 60).padStart(2, '0')}:00`;
    return {
      columns: ['block', 'start', 'end', 'path', 'estimate', 'finished'],
      rows: [['blocks/Focus.md', '2026-10-12T09:00', end, REPORT, '120', 0]],
      truncated: false,
    };
  });
  return { index: fakeIndexPort({ query }), query };
}

describe('useTaskSchedule', () => {
  it('reads a task’s schedule, and again when the index changes', async () => {
    let minutes = 60;
    const { index } = indexWith(() => minutes);
    const hook = renderHook(
      ({ indexKey }) =>
        useTaskSchedule({ index, types: TYPES, path: REPORT, typeName: 'task', indexKey }),
      { initialProps: { indexKey: 'one' } },
    );

    await waitFor(() =>
      expect(hook.result.current).toEqual({
        schedule: { estimate: 120, scheduled: 60, done: 0, overBy: 0 },
      }),
    );

    minutes = 180;
    hook.rerender({ indexKey: 'two' });

    await waitFor(() =>
      expect(hook.result.current).toEqual({
        schedule: { estimate: 120, scheduled: 180, done: 0, overBy: 60 },
      }),
    );
  });

  it('reads nothing for a note that is not a task', async () => {
    const { index, query } = indexWith(() => 60);
    const hook = renderHook(() =>
      useTaskSchedule({ index, types: TYPES, path: REPORT, typeName: 'project', indexKey: 'one' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hook.result.current).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('says why when the index could not be read', async () => {
    const index = fakeIndexPort({
      query: async () => Promise.reject(new Error('the index is busy')),
    });
    const hook = renderHook(() =>
      useTaskSchedule({ index, types: TYPES, path: REPORT, typeName: 'Task', indexKey: 'one' }),
    );
    await waitFor(() => expect(hook.result.current).toEqual({ problem: 'the index is busy' }));
  });
});
