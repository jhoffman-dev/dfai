import { describe, expect, it } from 'vitest';
import { FocusNotChosenError } from './choose-for-today.ts';
import {
  taskRowAsChanged,
  taskRowChange,
  taskRowStillOffers,
  type TaskRowProperties,
} from './task-row-change.ts';

const TODAY = '2026-10-28';

/** A rule-shaped change worked out against a task's properties, as a write works it out. */
const applied = (change: ReturnType<typeof taskRowChange>, properties: Record<string, unknown>) =>
  typeof change === 'function' ? change(properties) : change;

const row = (asRead: Partial<TaskRowProperties['asRead']>, more: Partial<TaskRowProperties> = {}) =>
  ({
    asRead: { status: 'next-action', due: null, defer: null, focus: null, ...asRead },
    focusIsOwn: false,
    recurrence: null,
    ...more,
  }) as TaskRowProperties;

describe('taskRowChange (#107): the one change each row action makes', () => {
  it('ticks a task finished, and rolls a repeating one on', () => {
    const done = taskRowChange({ kind: 'done' });
    expect(applied(done, { status: 'next-action' })).toEqual({ status: 'archive' });
    expect(
      applied(done, { status: 'next-action', recurrence: 'every week', due: '2026-10-28' }),
    ).toEqual({ status: 'next-action', due: '2026-11-04', lastCompleted: '2026-10-28' });
  });

  it('leaves a task that is already finished as it is when ticked', () => {
    const done = taskRowChange({ kind: 'done' });
    expect(
      applied(done, { status: 'archive', recurrence: 'every week', due: '2026-10-28' }),
    ).toEqual({});
  });

  it('makes a move to Archive a tick, so a repeating task rolls on from the menu too', () => {
    const moved = taskRowChange({ kind: 'move', status: 'archive' });
    expect(applied(moved, { recurrence: 'every week', due: '2026-10-28' })).toEqual(
      applied(taskRowChange({ kind: 'done' }), { recurrence: 'every week', due: '2026-10-28' }),
    );
  });

  it('moves to any other status as written, and reopens a finished task to Next Action', () => {
    expect(taskRowChange({ kind: 'move', status: 'waiting' })).toEqual({ status: 'waiting' });
    const reopen = taskRowChange({ kind: 'reopen' });
    expect(applied(reopen, { status: 'archive' })).toEqual({ status: 'next-action' });
    expect(applied(reopen, { status: [' archive '] })).toEqual({ status: 'next-action' });
    expect(applied(reopen, { status: 'in-progress' })).toEqual({});
  });

  it('chooses for today, takes it off, and never writes over the person’s own focus', () => {
    const choose = taskRowChange({ kind: 'choice', choice: 'choose', today: TODAY });
    expect(applied(choose, {})).toEqual({ focus: TODAY });
    const unchoose = taskRowChange({ kind: 'choice', choice: 'unchoose', today: TODAY });
    expect(applied(unchoose, { focus: TODAY })).toEqual({ focus: null });
    expect(() => applied(choose, { focus: 'when it rains' })).toThrow(FocusNotChosenError);
  });
});

describe('taskRowAsChanged: a row as its change leaves it, before the write lands', () => {
  it('is a tick dated today, the day’s choice ended, as the task rules write it', () => {
    const changes = taskRowAsChanged({
      task: row({ focus: TODAY }),
      values: taskRowChange({ kind: 'done' }),
      today: TODAY,
    });
    expect(changes).toEqual({ status: 'archive', completed: TODAY, focus: null });
  });

  it('is where a repeating task’s roll puts it', () => {
    const changes = taskRowAsChanged({
      task: row({ due: '2026-10-28' }, { recurrence: 'every week' }),
      values: taskRowChange({ kind: 'done' }),
      today: TODAY,
    });
    expect(changes).toMatchObject({ status: 'next-action', due: '2026-11-04' });
  });

  it('leaves a focus that is the person’s own out of what a rule could end', () => {
    const changes = taskRowAsChanged({
      task: row({ focus: null }, { focusIsOwn: true }),
      values: taskRowChange({ kind: 'done' }),
      today: TODAY,
    });
    expect(changes).toEqual({ status: 'archive', completed: TODAY });
  });

  it('is null when it cannot be known before the write, or is refused', () => {
    const unknown = taskRowAsChanged({
      task: row({}, { recurrence: undefined }),
      values: taskRowChange({ kind: 'done' }),
      today: TODAY,
    });
    expect(unknown).toBeNull();
    const refused = taskRowAsChanged({
      task: row({}),
      values: () => {
        throw new FocusNotChosenError();
      },
      today: TODAY,
    });
    expect(refused).toBeNull();
  });
});

describe('taskRowStillOffers: whether Try again still means what was asked', () => {
  const state = (status: string, more: { due?: string; focus?: string } = {}) =>
    ({
      asRead: { status, due: more.due ?? null, defer: null, focus: more.focus ?? null },
      focusIsOwn: false,
      recurrence: null,
    }) as unknown as Parameters<typeof taskRowStillOffers>[0]['asked'];
  const offers = (
    asked: ReturnType<typeof state>,
    now: ReturnType<typeof state>,
    action: Parameters<typeof taskRowChange>[0],
  ) => taskRowStillOffers({ asked, now, action, choosing: true });

  it('offers the same action again while the row reads the task as it did', () => {
    const open = state('next-action');
    expect(offers(open, open, { kind: 'done' })).toBe(true);
    expect(offers(open, open, { kind: 'move', status: 'waiting' })).toBe(true);
    expect(offers(open, open, { kind: 'choice', choice: 'choose', today: TODAY })).toBe(true);
  });

  it('offers nothing once the row reads the task differently, as a roll made elsewhere leaves it', () => {
    const asked = state('next-action', { due: '2026-10-28' });
    const rolled = state('next-action', { due: '2026-11-04' });
    expect(offers(asked, rolled, { kind: 'done' })).toBe(false);
  });

  it('offers nothing the row no longer offers', () => {
    const done = state('archive');
    expect(offers(done, done, { kind: 'done' })).toBe(false);
    expect(offers(done, done, { kind: 'reopen' })).toBe(true);
    expect(offers(done, done, { kind: 'move', status: 'archive' })).toBe(false);
    const chosen = state('next-action', { focus: TODAY });
    expect(offers(chosen, chosen, { kind: 'choice', choice: 'choose', today: TODAY })).toBe(false);
    expect(offers(chosen, chosen, { kind: 'choice', choice: 'unchoose', today: TODAY })).toBe(true);
    // The next day, it is no longer chosen for today: choosing means something again.
    expect(offers(chosen, chosen, { kind: 'choice', choice: 'choose', today: '2026-10-29' })).toBe(
      true,
    );
  });
});
