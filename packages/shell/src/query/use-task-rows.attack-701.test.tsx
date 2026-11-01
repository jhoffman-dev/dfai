// @vitest-environment jsdom
/**
 * Attack on PR #701 (#698), on a query view's task rows: a row acted on
 * settles on a run stamped with the index's own key past where it stood as
 * the write's refresh was asked. These probe a run under way as the write
 * lands, and a key that moved because the refresh failed.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { TASK_ROW_COLUMNS, TASK_TYPE_FILE, taskAsRead, type BoardRow } from '@dfai/domain';
import { fakeVaultFs, memoryVault, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useTaskRows, type TaskRowsOptions } from './use-task-rows.ts';

const CALL = 'Tasks/Call Tobias.md';
const TASK = '---\ntype: task\nstatus: next-action\n---\n\n# Call Tobias\n';
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

function rowAt(status: string): BoardRow {
  const read = taskAsRead({ status });
  return {
    path: CALL,
    title: 'Call Tobias',
    values: {
      type: 'task',
      status,
      [TASK_ROW_COLUMNS.status]: read.status,
      [TASK_ROW_COLUMNS.due]: read.due,
      [TASK_ROW_COLUMNS.defer]: read.defer,
      [TASK_ROW_COLUMNS.focus]: read.focus,
      [TASK_ROW_COLUMNS.focusIsOwn]: 0,
      [TASK_ROW_COLUMNS.recurrence]: null,
    },
  };
}

function view() {
  const memory = memoryVault({ [CALL]: TASK });
  /** The index's own key, ahead of the news the view runs on, and the runs begun. */
  const index = { key: 'ready:1', runs: 1 };
  const initial: TaskRowsOptions = {
    rows: [rowAt('next-action')],
    read: { at: 1, indexKey: 'ready:1' },
    runsBegun: () => index.runs,
    indexKeyNow: () => index.key,
    enabled: true,
    scope: ['index', 'Views/Next actions.md'],
    ports: {
      fs: fakeVaultFs(memory.fs),
      markdown: remarkMarkdown,
      editors: noPane,
      activity: recordingActivity(),
    },
    clock: { today: () => '2026-10-28' },
    types: [TASK_TYPE_FILE.type],
    onChanged: () => {},
  };
  const hook = renderHook((options: TaskRowsOptions) => useTaskRows(options), {
    initialProps: initial,
  });
  /** A run begins now, at the index's key now; `lands` draws what it read. */
  const begin = () => {
    index.runs += 1;
    const read = { at: index.runs, indexKey: index.key };
    return (status: string) => hook.rerender({ ...initial, rows: [rowAt(status)], read });
  };
  const run = (status: string) => begin()(status);
  const status = () => hook.result.current.rows[0]?.values['status'];
  const file = () => memory.files.get(CALL) ?? '';
  const someday = async () => {
    const row = hook.result.current.rows[0] ?? expect.fail('no row');
    act(() => hook.result.current.controls?.onMove(row, 'someday'));
    await waitFor(() => expect(file()).toContain('status: someday'));
    await act(async () => {});
  };
  return { index, begin, run, status, someday };
}

describe('useTaskRows — attack #701', () => {
  it('probe: a run begun before the write landed, drawn after the index moved, does not settle the row', async () => {
    const { index, begin, status, someday } = view();
    // A run begins on news of an index that moved just before the write, and is still under way.
    index.key = 'ready:2';
    const landsLate = begin();
    // The index moves again before the write lands: the run's key is not the one the write
    // lands at, so only its having begun first keeps it behind the write.
    index.key = 'ready:3';
    await someday();
    landsLate('next-action');
    expect(status()).toBe('someday');
  });

  // FOUND, and fixed: the write's refresh failed, so the index never took the write in, and
  // `failed:2` differing from `ready:1` read as standing for the write. A run of an index
  // that is not ready now stands for no write: the row stays as its change left it, waiting,
  // until the index is ready past it.
  it('keeps a row as its change left it through a run of an index whose refresh failed, until the index is ready', async () => {
    const { index, run, status, someday } = view();
    await someday();
    index.key = 'failed:2';
    run('next-action');
    expect(status()).toBe('someday');
    // Ready again, past the write: the index's read stands, whatever it says.
    index.key = 'ready:3';
    run('next-action');
    expect(status()).toBe('next-action');
  });
});
