import { describe, expect, it } from 'vitest';
import {
  listsTasksAlone,
  TASK_ROW_COLUMNS,
  taskRowFacts,
  taskRowState,
  taskRowWithChanges,
} from './task-row.ts';

const TODAY = '2026-10-28';

const carried = (values: Partial<Record<keyof typeof TASK_ROW_COLUMNS, unknown>>) =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      TASK_ROW_COLUMNS[key as keyof typeof TASK_ROW_COLUMNS],
      value,
    ]),
  );

describe('listsTasksAlone', () => {
  it('is a query of tasks and nothing else, in any case and spacing', () => {
    expect(listsTasksAlone(['task'])).toBe(true);
    expect(listsTasksAlone([' Task '])).toBe(true);
    expect(listsTasksAlone(['task', 'project'])).toBe(false);
    expect(listsTasksAlone(['project'])).toBe(false);
    expect(listsTasksAlone([])).toBe(false);
  });
});

describe('taskRowState', () => {
  it('reads the hidden columns as Today reads its rows', () => {
    const state = taskRowState(
      carried({
        status: 'next-action',
        due: '2026-11-02',
        defer: null,
        focus: TODAY,
        focusIsOwn: 0,
        recurrence: 'every week',
      }),
    );
    expect(state).toEqual({
      asRead: { status: 'next-action', due: '2026-11-02', defer: null, focus: TODAY },
      focusIsOwn: false,
      recurrence: 'every week',
    });
  });

  it('says a focus is the person’s own, and reads an unknown status as none', () => {
    const state = taskRowState(carried({ status: 'later maybe', focusIsOwn: 1 }));
    expect(state?.focusIsOwn).toBe(true);
    expect(state?.asRead.status).toBeNull();
    expect(state?.recurrence).toBeNull();
  });

  it('is null for a row that carries no task state: a query block’s, or one of several types', () => {
    expect(taskRowState({ path: 'Tasks/Call.md', status: 'next-action' })).toBeNull();
  });
});

describe('taskRowWithChanges', () => {
  it('lays a change over a shown column and the hidden one alike, and takes a null out', () => {
    const values = { status: 'next-action', ...carried({ status: 'next-action', focus: TODAY }) };
    const laid = taskRowWithChanges(values, { status: 'archive', completed: TODAY, focus: null });
    expect(laid['status']).toBe('archive');
    expect(laid[TASK_ROW_COLUMNS.status]).toBe('archive');
    expect(laid[TASK_ROW_COLUMNS.focus]).toBeNull();
    // A key the row neither shows nor carries is not added to it.
    expect(Object.hasOwn(laid, 'completed')).toBe(false);
    expect(Object.hasOwn(laid, 'focus')).toBe(false);
  });
});

describe('taskRowFacts', () => {
  const state = (status: string, focus: string | null, focusIsOwn = 0) =>
    taskRowState(carried({ status, focus, focusIsOwn })) ?? expect.fail('no state');

  it('ticks the box of a finished task only', () => {
    expect(taskRowFacts({ state: state('archive', null), today: TODAY, choosing: true }).done).toBe(
      true,
    );
    expect(taskRowFacts({ state: state('waiting', null), today: TODAY, choosing: true }).done).toBe(
      false,
    );
  });

  it('offers every one of the eight statuses but its own, Archive included', () => {
    const { moves } = taskRowFacts({ state: state('waiting', null), today: TODAY, choosing: true });
    expect(moves).toEqual([
      'inbox',
      'backlog',
      'next-action',
      'in-progress',
      'someday',
      'longterm',
      'archive',
    ]);
  });

  it('shows Today pressed for a task chosen for today, and not for a later day', () => {
    const chosen = (focus: string | null) =>
      taskRowFacts({ state: state('next-action', focus), today: TODAY, choosing: true }).chosen;
    expect(chosen(TODAY)).toBe(true);
    expect(chosen('2026-10-30')).toBe(false);
    expect(chosen(null)).toBe(false);
  });

  it('has no Today toggle where the vault does not choose, or the focus is the person’s own', () => {
    expect(
      taskRowFacts({ state: state('next-action', null), today: TODAY, choosing: false }).chosen,
    ).toBeNull();
    expect(
      taskRowFacts({ state: state('next-action', null, 1), today: TODAY, choosing: true }).chosen,
    ).toBeNull();
  });
});
