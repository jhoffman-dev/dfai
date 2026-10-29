// @vitest-environment jsdom
/**
 * PR #625 (#107) under attack: a query view's task rows pressed where the
 * file and the row disagree, the day turns, two views hold one task, and the
 * task goes away before Try again.
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
import { fakeVaultFs, memoryVault, NoteChangedError, recordingActivity } from '@dfai/application';
import { createVaultPath } from '@dfai/domain';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useTaskRows, type TaskRowsOptions } from './use-task-rows.ts';

const TODAY = '2026-10-28';
const PATH = 'Tasks/Feed the hens.md';
const TYPES: readonly ObjectType[] = [TASK_TYPE_FILE.type];
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

/** A row as the hidden columns carry it: the index's reading, a blank item being no item. */
function rowOf(
  properties: Readonly<Record<string, unknown>>,
  hidden: Partial<Record<keyof typeof TASK_ROW_COLUMNS, unknown>> = {},
): BoardRow {
  const read = taskAsRead(properties);
  return {
    path: PATH,
    title: 'Feed the hens',
    values: {
      type: 'task',
      [TASK_ROW_COLUMNS.status]: read.status,
      [TASK_ROW_COLUMNS.due]: read.due,
      [TASK_ROW_COLUMNS.defer]: read.defer,
      [TASK_ROW_COLUMNS.focus]: read.focus,
      [TASK_ROW_COLUMNS.focusIsOwn]: 0,
      [TASK_ROW_COLUMNS.recurrence]: null,
      ...Object.fromEntries(
        Object.entries(hidden).map(([key, value]) => [
          TASK_ROW_COLUMNS[key as keyof typeof TASK_ROW_COLUMNS],
          value,
        ]),
      ),
    },
  };
}

function viewOf(
  memory: ReturnType<typeof memoryVault>,
  row: BoardRow,
  clock: { today: () => string } = { today: () => TODAY },
) {
  let writes = 0;
  const fs = fakeVaultFs({
    ...memory.fs,
    writeTextFile: async (write) => {
      writes += 1;
      return memory.fs.writeTextFile(write);
    },
  });
  let runs = 1;
  const initial: TaskRowsOptions = {
    rows: [row],
    read: { at: 1, indexKey: 'ready:1' },
    runsBegun: () => runs,
    indexKey: 'ready:1',
    enabled: true,
    scope: ['index', 'Views/Next actions.md'],
    ports: { fs, markdown: remarkMarkdown, editors: noPane, activity: recordingActivity() },
    clock,
    types: TYPES,
    onChanged: () => {},
  };
  const hook = renderHook((options: TaskRowsOptions) => useTaskRows(options), {
    initialProps: initial,
  });
  const current = () => hook.result.current.rows[0] ?? expect.fail('no row');
  return {
    hook,
    row: current,
    shown: () => hook.result.current.controls?.of(current()),
    controls: () => hook.result.current.controls ?? expect.fail('no controls'),
    writes: () => writes,
    /** The view runs again; the index has not moved (`moved` false) or has. */
    runAgain: (next: BoardRow, moved: boolean) => {
      runs += 1;
      const indexKey = moved ? `ready:${runs}` : 'ready:1';
      hook.rerender({ ...initial, rows: [next], read: { at: runs, indexKey }, indexKey });
    },
    /** Something else draws the view again: the same rows, the same read. */
    redraw: () => hook.rerender({ ...initial }),
  };
}

const flush = () => act(async () => await Promise.resolve());

describe('useTaskRows under attack (PR #625)', () => {
  // [archive, next-action] reads as no one status, so the box is drawn unticked;
  // the tick's own guard (`holdsStatus`) finds archive among the items and writes nothing.
  const MIXED = '---\ntype: task\nstatus: [archive, next-action]\n---\n\nBody.\n';
  const MIXED_READ = { status: ['archive', 'next-action'] };

  it('a row drawn unticked is finished by its tick', async () => {
    const memory = memoryVault({ [PATH]: MIXED });
    const view = viewOf(memory, rowOf(MIXED_READ));
    expect(view.shown()?.done).toBe(false);
    act(() => view.controls().onDone(view.row(), true));
    await flush();
    await flush();
    expect(memory.files.get(PATH)).toMatch(/^status: archive$/m);
  });

  it('a press whose write changed nothing does not hold the row waiting for an index that never moves', async () => {
    const memory = memoryVault({ [PATH]: MIXED });
    const view = viewOf(memory, rowOf(MIXED_READ));
    act(() => view.controls().onDone(view.row(), true));
    await flush();
    await flush();
    // Nothing was written, so the index has no news: the view's re-run reads it as before.
    expect(view.writes()).toBe(0);
    view.runAgain(rowOf(MIXED_READ), false);
    view.runAgain(rowOf(MIXED_READ), false);
    expect(view.shown()).toMatchObject({ done: false, waits: false });
  });

  it('draws the Today toggle against the day it is drawn on, not the day the view first drew', () => {
    let day = TODAY;
    const memory = memoryVault({
      [PATH]: `---\ntype: task\nstatus: next-action\nfocus: ${TODAY}\n---\n`,
    });
    const view = viewOf(memory, rowOf({ status: 'next-action', focus: TODAY }), {
      today: () => day,
    });
    expect(view.shown()?.chosen).toBe(true);
    day = '2026-10-29';
    view.redraw();
    // Yesterday's choice is carried over, not chosen for today, as Today itself draws it.
    expect(view.shown()?.chosen).toBe(false);
  });

  it('two views of one task: the second tick is refused, the file rolled once', async () => {
    const text = `---\ntype: task\nstatus: next-action\ndue: 2026-10-28\nrecurrence: every week\n---\n`;
    const read = { status: 'next-action', due: '2026-10-28' };
    const memory = memoryVault({ [PATH]: text });
    const first = viewOf(memory, rowOf(read, { recurrence: 'every week' }));
    const second = viewOf(memory, rowOf(read, { recurrence: 'every week' }));
    act(() => first.controls().onDone(first.row(), true));
    await waitFor(() => expect(memory.files.get(PATH)).toContain('due: 2026-11-04'));
    act(() => second.controls().onDone(second.row(), true));
    await waitFor(() => expect(second.shown()?.refusal).not.toBeNull());
    expect(memory.files.get(PATH)).toContain('due: 2026-11-04');
    expect(memory.files.get(PATH)).not.toContain('2026-11-11');
  });

  it('Try again after the task was deleted writes nothing and leaves no file behind', async () => {
    const text = '---\ntype: task\nstatus: next-action\n---\n';
    const memory = memoryVault({ [PATH]: text });
    const view = viewOf(memory, rowOf({ status: 'next-action' }));
    memory.files.set(PATH, '---\ntype: task\nstatus: waiting\n---\n');
    act(() => view.controls().onDone(view.row(), true));
    await waitFor(() => expect(view.shown()?.refusal).not.toBeNull());
    memory.files.delete(PATH);
    act(() => view.shown()?.refusal?.onRetry());
    await flush();
    await flush();
    expect(memory.files.has(PATH)).toBe(false);
    expect(view.writes()).toBe(0);
  });

  it('a press on a held row writes nothing more', async () => {
    const text = '---\ntype: task\nstatus: next-action\n---\n';
    const memory = memoryVault({ [PATH]: text });
    const view = viewOf(memory, rowOf({ status: 'next-action' }));
    act(() => view.controls().onDone(view.row(), true));
    expect(view.shown()?.waits).toBe(true);
    act(() => view.controls().onMove(view.row(), 'waiting'));
    act(() => view.controls().onToday(view.row(), false));
    await waitFor(() => expect(view.writes()).toBe(1));
    await flush();
    expect(view.writes()).toBe(1);
    expect(memory.files.get(PATH)).toMatch(/^status: archive$/m);
    // Not even tried: a press let through would be refused as "changed since", and said on the row.
    expect(view.shown()?.refusal ?? null).toBeNull();
  });
});

/**
 * A disk that stamps each write and refuses one whose stamp or text moved, as
 * the host does; `meddle` runs after each read, as another program might write.
 */
function stampedDisk(text: string, meddle: (reads: number) => string | null) {
  let file: { text: string; modified: number } | null = { text, modified: 100 };
  let reads = 0;
  let writes = 0;
  const fs = fakeVaultFs({
    ...memoryVault({}).fs,
    readTextFile: async () => {
      if (file === null) throw new Error('no such file');
      const read = { ...file };
      reads += 1;
      const other = meddle(reads);
      if (other !== null) file = { text: other, modified: file.modified + 1 };
      return read;
    },
    writeTextFile: async ({ contents, expectedModified, expectedText }) => {
      if (file === null) throw new Error('no such file');
      if (expectedModified !== null && expectedModified !== file.modified)
        throw new NoteChangedError(createVaultPath(PATH));
      if (expectedText !== undefined && expectedText !== file.text)
        throw new NoteChangedError(createVaultPath(PATH));
      writes += 1;
      file = { text: contents, modified: file.modified + 1 };
      return file.modified;
    },
  });
  return { fs, text: () => file?.text, writes: () => writes };
}

describe('useTaskRows racing the disk (PR #625)', () => {
  const OPEN = '---\ntype: task\nstatus: next-action\n---\n\nBody.\n';
  const EDITED = `${OPEN}edited on the other Mac\n`;

  it.each([1, 2])(
    'keeps an edit that lands after read %i of a tick, refusing the tick on its row',
    async (after) => {
      const disk = stampedDisk(OPEN, (reads) => (reads === after ? EDITED : null));
      const hook = renderHook(() =>
        useTaskRows({
          rows: [rowOf({ status: 'next-action' })],
          read: { at: 1, indexKey: 'ready:1' },
          runsBegun: () => 1,
          indexKey: 'ready:1',
          enabled: true,
          scope: ['index', 'Views/Next actions.md'],
          ports: {
            fs: disk.fs,
            markdown: remarkMarkdown,
            editors: noPane,
            activity: recordingActivity(),
          },
          clock: { today: () => TODAY },
          types: TYPES,
          onChanged: () => {},
        }),
      );
      const row = hook.result.current.rows[0] ?? expect.fail('no row');
      act(() => hook.result.current.controls?.onDone(row, true));
      await waitFor(() => expect(hook.result.current.controls?.of(row)?.refusal).not.toBeNull());
      expect(disk.text()).toBe(EDITED);
      expect(disk.writes()).toBe(0);
    },
  );

  it('an Undo after another edit to the task is refused, keeping that edit', async () => {
    const memory = memoryVault({ [PATH]: OPEN });
    const toasts: { message: string; tone: string; onUndo?: () => void }[] = [];
    let runs = 1;
    const options = {
      rows: [rowOf({ status: 'next-action' })],
      read: { at: 1, indexKey: 'ready:1' },
      runsBegun: () => runs,
      indexKey: 'ready:1',
      enabled: true,
      scope: ['index', 'Views/Next actions.md'],
      ports: {
        fs: fakeVaultFs(memory.fs),
        markdown: remarkMarkdown,
        editors: noPane,
        activity: recordingActivity(),
      },
      clock: { today: () => TODAY },
      types: TYPES,
      toasts: {
        show: (toast: { message: string; tone: string; onUndo?: () => void }) => toasts.push(toast),
        vaultNow: () => 'vault-a',
      },
      onChanged: () => {},
    };
    const hook = renderHook((props: TaskRowsOptions) => useTaskRows(props), {
      initialProps: options,
    });
    const row = hook.result.current.rows[0] ?? expect.fail('no row');
    act(() => hook.result.current.controls?.onDone(row, true));
    await waitFor(() => expect(toasts).toHaveLength(1));
    // The view reads the tick back, then the task is moved on another Mac.
    runs += 1;
    hook.rerender({
      ...options,
      rows: [rowOf({ status: 'archive' })],
      read: { at: runs, indexKey: 'ready:2' },
      indexKey: 'ready:2',
    });
    const moved = (memory.files.get(PATH) ?? '').replace('status: archive', 'status: waiting');
    memory.files.set(PATH, moved);
    act(() => toasts[0]?.onUndo?.());
    await waitFor(() => expect(toasts).toHaveLength(2));
    expect(toasts[1]?.tone).toBe('warning');
    expect(memory.files.get(PATH)).toBe(moved);
  });
});
