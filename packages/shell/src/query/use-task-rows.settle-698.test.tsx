// @vitest-environment jsdom
/**
 * #698, on a query view's task rows: a row acted on settles only on a run of
 * the query begun once the index has moved past where it stood as the
 * write's refresh was asked. The news of an index that moved just before the
 * write landed reaches the view later, and a run begun on it is of the vault
 * from before the write: drawing it put the row back as it was.
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
    indexKey: 'ready:1',
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
  /** A run of the query begins, at the index's key now, and reads the task as `status`. */
  const run = (status: string) => {
    index.runs += 1;
    const read = { at: index.runs, indexKey: index.key };
    hook.rerender({ ...initial, rows: [rowAt(status)], read, indexKey: index.key });
  };
  const status = () => hook.result.current.rows[0]?.values['status'];
  const file = () => memory.files.get(CALL) ?? '';
  return { hook, index, run, status, file };
}

describe('useTaskRows — settling on news that comes late (#698)', () => {
  it('keeps a row as its change left it through a run of an index that moved before the write landed', async () => {
    const { hook, index, run, status, file } = view();
    // Another note's refresh, which read the vault before this write, has moved the index.
    index.key = 'ready:2';
    const row = hook.result.current.rows[0] ?? expect.fail('no row');
    act(() => hook.result.current.controls?.onMove(row, 'someday'));
    await waitFor(() => expect(file()).toContain('status: someday'));
    await act(async () => {});
    expect(status()).toBe('someday');

    // Its news arrives after the write landed: the run is of the index from before it.
    run('next-action');
    expect(status()).toBe('someday');

    // The write's own refresh runs: the index has it, moves, and the row is read back.
    index.key = 'ready:3';
    run('someday');
    expect(status()).toBe('someday');
    const settled = hook.result.current.rows[0] ?? expect.fail('no row');
    expect(hook.result.current.controls?.of(settled)?.waits).toBe(false);
  });

  it('control: a run of an index that moved after the write landed reads the row back', async () => {
    const { hook, index, run, status, file } = view();
    const row = hook.result.current.rows[0] ?? expect.fail('no row');
    act(() => hook.result.current.controls?.onMove(row, 'someday'));
    await waitFor(() => expect(file()).toContain('status: someday'));
    await act(async () => {});
    index.key = 'ready:2';
    run('next-action');
    expect(status()).toBe('next-action');
  });
});
