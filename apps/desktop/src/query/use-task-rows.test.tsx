// @vitest-environment jsdom
/**
 * #107: a query view's task rows ticked, moved and chosen for today — drawn
 * at once, written as Today writes them, undoable, and a refused change
 * said on its row with the change kept to try again.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  TASK_ROW_COLUMNS,
  TASK_TYPE_FILE,
  taskAsRead,
  type BoardRow,
  type ObjectType,
} from '@dfai/domain';
import { fakeVaultFs, memoryVault, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useTaskRows, type TaskRowsOptions } from './use-task-rows.ts';

const TODAY = '2026-10-28';
const CALL = 'Tasks/Call Tobias.md';
const TYPES: readonly ObjectType[] = [TASK_TYPE_FILE.type];
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

/** A task row as the query view's run reads it: what it shows, and its task's hidden state. */
function rowOf(path: string, properties: Readonly<Record<string, unknown>>): BoardRow {
  const read = taskAsRead(properties);
  return {
    path,
    title: path.slice(6, -3),
    values: {
      type: 'task',
      status: properties['status'],
      [TASK_ROW_COLUMNS.status]: read.status,
      [TASK_ROW_COLUMNS.due]: read.due,
      [TASK_ROW_COLUMNS.defer]: read.defer,
      [TASK_ROW_COLUMNS.focus]: read.focus,
      [TASK_ROW_COLUMNS.focusIsOwn]: 0,
      [TASK_ROW_COLUMNS.recurrence]: properties['recurrence'] ?? null,
    },
  };
}

interface Toast {
  readonly message: string;
  readonly tone: string;
  readonly onUndo?: () => void;
}

function rows(text: string, read: Readonly<Record<string, unknown>> = { status: 'next-action' }) {
  const memory = memoryVault({ [CALL]: text });
  let failing: string | null = null;
  let writes = 0;
  // The day the clock says now: moved on in a test, as midnight passing would.
  let day = TODAY;
  const fs = fakeVaultFs({
    ...memory.fs,
    writeTextFile: async (write) => {
      if (failing !== null) throw new Error(failing);
      writes += 1;
      return memory.fs.writeTextFile(write);
    },
  });
  const toasts: Toast[] = [];
  const activity = recordingActivity();
  let changed = 0;
  let runs = 1;
  const initial: TaskRowsOptions = {
    rows: [rowOf(CALL, read)],
    read: { at: 1, indexKey: 'ready:1' },
    runsBegun: () => runs,
    indexKey: 'ready:1',
    enabled: true,
    scope: ['index', 'Views/Next actions.md'],
    ports: { fs, markdown: remarkMarkdown, editors: noPane, activity },
    clock: { today: () => day },
    types: TYPES,
    toasts: {
      show: (toast) => {
        toasts.push(toast);
        return toasts.length;
      },
      vaultNow: () => 'vault-a',
    },
    onChanged: () => {
      changed += 1;
    },
  };
  const hook = renderHook((options: TaskRowsOptions) => useTaskRows(options), {
    initialProps: initial,
  });
  const row = () => hook.result.current.rows[0] ?? expect.fail('no row');
  const shown = () => hook.result.current.controls?.of(row());
  return {
    hook,
    row,
    shown,
    toasts,
    activity,
    file: () => memory.files.get(CALL),
    /** Changes the file behind the view's back, as another app would. */
    writeFile: (text: string) => memory.files.set(CALL, text),
    writes: () => writes,
    changes: () => changed,
    /** Midnight passes: the clock says another day, and nothing draws the view again. */
    turnDay: (next: string) => {
      day = next;
    },
    fail: (message: string | null) => {
      failing = message;
    },
    /** The view's run reads these rows. */
    show: (shown: readonly BoardRow[]) => hook.rerender({ ...initial, rows: shown }),
    /** The query's run carries no task state: one of several types. */
    disable: () => hook.rerender({ ...initial, enabled: false }),
    /** The index reads the file again, and the view runs again after the write. */
    readAgain: (properties: Readonly<Record<string, unknown>>) => {
      runs += 1;
      hook.rerender({
        ...initial,
        rows: [rowOf(CALL, properties)],
        read: { at: runs, indexKey: `ready:${runs}` },
        indexKey: `ready:${runs}`,
      });
    },
  };
}

const TASK = '---\ntype: task\nstatus: next-action # the next thing\n---\n\n# Call Tobias\n';

describe('useTaskRows', () => {
  it('ticks a row: drawn finished at once, written as a tick, said with an Undo that puts back every byte', async () => {
    const view = rows(TASK);
    expect(view.shown()).toMatchObject({ done: false, waits: false, refusal: null });
    act(() => view.hook.result.current.controls?.onDone(view.row(), true));
    // Drawn as the tick leaves it before the write has landed, and held until it is read back.
    expect(view.row().values['status']).toBe('archive');
    expect(view.shown()).toMatchObject({ done: true, waits: true });
    await waitFor(() => expect(view.toasts).toHaveLength(1));
    expect(view.file()).toBe(
      '---\ntype: task\nstatus: archive # the next thing\ncompleted: 2026-10-28\n---\n\n# Call Tobias\n',
    );
    expect(view.toasts[0]?.message).toBe('Finished “Call Tobias”.');
    expect(view.changes()).toBe(1);

    view.readAgain({ status: 'archive' });
    expect(view.shown()).toMatchObject({ done: true, waits: false });
    act(() => view.toasts[0]?.onUndo?.());
    await waitFor(() => expect(view.file()).toBe(TASK));
  });

  it('takes no second action on a row until its first is read back', async () => {
    const view = rows(TASK);
    act(() => view.hook.result.current.controls?.onDone(view.row(), true));
    act(() => view.hook.result.current.controls?.onMove(view.row(), 'waiting'));
    await waitFor(() => expect(view.toasts).toHaveLength(1));
    expect(view.file()).toContain('status: archive');
    // Everything asked has settled: one write, one toast, one re-read asked for.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(view.writes()).toBe(1);
    expect(view.toasts).toHaveLength(1);
    expect(view.changes()).toBe(1);
  });

  it('chooses for the day the Today toggle is pressed, not the day the view was drawn', async () => {
    const view = rows(TASK);
    expect(view.shown()?.chosen).toBe(false);
    view.turnDay('2026-10-29');
    act(() => view.hook.result.current.controls?.onToday(view.row(), false));
    await waitFor(() => expect(view.toasts).toHaveLength(1));
    expect(view.file()).toContain('focus: 2026-10-29\n');
    expect(view.toasts[0]?.message).toBe('Chose “Call Tobias” for today.');
  });

  it('tries a refused choice again on the day Try again is pressed', async () => {
    const moved = TASK.replace('next-action', 'waiting');
    const view = rows(moved);
    act(() => view.hook.result.current.controls?.onToday(view.row(), false));
    await waitFor(() => expect(view.shown()?.refusal).not.toBeNull());
    view.writeFile(TASK);
    view.turnDay('2026-10-29');
    act(() => view.shown()?.refusal?.onRetry());
    await waitFor(() => expect(view.toasts).toHaveLength(1));
    expect(view.file()).toContain('focus: 2026-10-29\n');
  });

  it('does not tick a repeating task again when Try again finds it already rolled on elsewhere', async () => {
    const weekly = `---\ntype: task\nstatus: next-action\ndue: 2026-10-28\nrecurrence: every week\n---\n`;
    const read = { status: 'next-action', due: '2026-10-28', recurrence: 'every week' };
    const view = rows(weekly, read);
    // Ticked on Today in another pane first: the file has rolled, the view has not read it.
    const rolled = `---\ntype: task\nstatus: next-action\ndue: 2026-11-04\nrecurrence: every week\nlastCompleted: 2026-10-28\n---\n`;
    view.writeFile(rolled);
    act(() => view.hook.result.current.controls?.onDone(view.row(), true));
    await waitFor(() => expect(view.shown()?.refusal).not.toBeNull());

    view.readAgain({ ...read, due: '2026-11-04' });
    act(() => view.shown()?.refusal?.onRetry());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(view.file()).toBe(rolled);
    expect(view.writes()).toBe(0);
    // Nothing is said to try again: the row shows the task as it is now.
    expect(view.shown()?.refusal).toBeNull();
  });

  it('rolls a repeating task on and ends the day’s choice, drawn where the roll puts it', async () => {
    const text = `---\ntype: task\nstatus: next-action\ndue: 2026-10-28\nrecurrence: every week\nfocus: ${TODAY}\n---\n`;
    const view = rows(text, {
      status: 'next-action',
      due: '2026-10-28',
      recurrence: 'every week',
      focus: TODAY,
    });
    expect(view.shown()?.chosen).toBe(true);
    act(() => view.hook.result.current.controls?.onDone(view.row(), true));
    expect(view.row().values[TASK_ROW_COLUMNS.due]).toBe('2026-11-04');
    expect(view.shown()).toMatchObject({ done: false, chosen: false });
    await waitFor(() => expect(view.toasts).toHaveLength(1));
    expect(view.file()).toBe(
      '---\ntype: task\nstatus: next-action\ndue: 2026-11-04\nrecurrence: every week\nlastCompleted: 2026-10-28\n---\n',
    );
  });

  it('moves a row to another status from its menu', async () => {
    const view = rows(TASK);
    act(() => view.hook.result.current.controls?.onMove(view.row(), 'someday'));
    expect(view.row().values['status']).toBe('someday');
    await waitFor(() => expect(view.toasts).toHaveLength(1));
    expect(view.file()).toContain('status: someday # the next thing\n');
    expect(view.toasts[0]?.message).toBe('Moved “Call Tobias” to Someday.');
  });

  it('chooses a row for today, and takes it off again', async () => {
    const view = rows(TASK);
    expect(view.shown()?.chosen).toBe(false);
    act(() => view.hook.result.current.controls?.onToday(view.row(), false));
    expect(view.shown()?.chosen).toBe(true);
    await waitFor(() => expect(view.toasts).toHaveLength(1));
    expect(view.file()).toContain(`focus: ${TODAY}\n`);

    view.readAgain({ status: 'next-action', focus: TODAY });
    act(() => view.hook.result.current.controls?.onToday(view.row(), true));
    await waitFor(() => expect(view.toasts).toHaveLength(2));
    expect(view.file()).toBe(TASK);
    expect(view.toasts[1]?.message).toBe('Took “Call Tobias” off today.');
  });

  it('refuses a change to a task that moved on since the row read it: nothing written, said on the row, kept to try again', async () => {
    const moved = TASK.replace('next-action', 'waiting');
    const view = rows(moved);
    act(() => view.hook.result.current.controls?.onDone(view.row(), true));
    await waitFor(() => expect(view.shown()?.refusal).not.toBeNull());
    expect(view.file()).toBe(moved);
    expect(view.shown()?.refusal?.message).toMatch(/changed since/);
    // Back as read, free to act on, and the refusal recorded nowhere: it is no fault.
    expect(view.row().values['status']).toBe('next-action');
    expect(view.shown()?.waits).toBe(false);
    expect(view.activity.reports).toHaveLength(0);

    view.readAgain({ status: 'waiting' });
    // The refusal stays on the row until it is acted on again: Try again makes the same tick.
    act(() => view.shown()?.refusal?.onRetry());
    await waitFor(() => expect(view.file()).toContain('status: archive'));
    expect(view.shown()?.refusal).toBeNull();
  });

  it('says a failed write on the row and records it once', async () => {
    const view = rows(TASK);
    view.fail('The disk is full.');
    act(() => view.hook.result.current.controls?.onMove(view.row(), 'waiting'));
    await waitFor(() => expect(view.shown()?.refusal?.message).toBe('The disk is full.'));
    expect(view.row().values['status']).toBe('next-action');
    expect(view.activity.reports).toHaveLength(1);
    expect(view.toasts).toHaveLength(0);
  });

  it('gives no controls to a row that carries no task state', () => {
    const view = rows(TASK);
    view.show([{ path: 'Notes/Plain.md', title: 'Plain', values: { status: 'next-action' } }]);
    expect(view.hook.result.current.controls).toBeDefined();
    expect(view.hook.result.current.controls?.of(view.row())).toBeUndefined();
  });

  it('is look-only when the query is not of tasks alone', () => {
    const view = rows(TASK);
    view.disable();
    expect(view.hook.result.current.controls).toBeUndefined();
  });
});
