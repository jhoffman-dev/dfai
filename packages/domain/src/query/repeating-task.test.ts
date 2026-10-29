import { describe, expect, it } from 'vitest';
import { repeatingTaskUpdate } from './repeating-task.ts';

const update = (properties: Record<string, unknown>) =>
  repeatingTaskUpdate({ properties, statusKey: 'status', resetStatus: 'backlog' });

describe('repeatingTaskUpdate', () => {
  it('moves the due date on and puts the task back in play', () => {
    expect(update({ recurrence: 'weekly', due: '2026-09-20' })).toEqual({
      due: '2026-09-27',
      status: 'backlog',
      lastCompleted: '2026-09-20',
    });
  });

  it('understands every N days', () => {
    expect(update({ recurrence: 'every 3 days', due: '2026-09-20' })?.['due']).toBe('2026-09-23');
  });

  it('counts from when it was due, not from today', () => {
    // Finished weeks late; the next one still follows the one that was missed.
    expect(update({ recurrence: 'weekly', due: '2026-01-01' })?.['due']).toBe('2026-01-08');
  });

  it('records when it was last finished', () => {
    expect(update({ recurrence: 'daily', due: '2026-09-20T09:00:00Z' })?.['lastCompleted']).toBe(
      '2026-09-20',
    );
  });

  it.each([
    ['no recurrence', { due: '2026-09-20' }],
    ['a recurrence it cannot read', { recurrence: 'now and then', due: '2026-09-20' }],
    ['no due date', { recurrence: 'weekly' }],
    ['a due date it cannot read', { recurrence: 'weekly', due: 'soon' }],
    ['nothing at all', {}],
  ])('leaves a task with %s alone', (_label, properties) => {
    expect(update(properties)).toBeNull();
  });

  it('puts the task back to whatever the caller says', () => {
    expect(
      repeatingTaskUpdate({
        properties: { recurrence: 'daily', due: '2026-09-20' },
        statusKey: 'state',
        resetStatus: 'todo',
      }),
    ).toMatchObject({ state: 'todo' });
  });
});

describe('repeatingTaskUpdate on a recurrence written as a list (#107)', () => {
  it('rolls a task whose one rule is written as a list', () => {
    const update = repeatingTaskUpdate({
      properties: { recurrence: ['', 'every week'], due: '2026-10-28' },
      statusKey: 'status',
      resetStatus: 'next-action',
    });
    expect(update).toEqual({
      due: '2026-11-04',
      status: 'next-action',
      lastCompleted: '2026-10-28',
    });
  });
});
