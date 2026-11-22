import { describe, expect, it } from 'vitest';
import type { ReviewTask } from '../review/weekly-review.ts';
import { weeklyReview } from '../review/weekly-review.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { nextDueTurn, todayLists, type TodaySectionId } from './today-lists.ts';

/** #928: a timed due on the Today page and in the weekly review, on a fixed clock. */
const TODAY = '2026-12-04';
const NOW = Date.UTC(2026, 11, 4, 15, 30);
const at = (time?: string) => ({ today: TODAY, now: NOW, ...(time !== undefined && { time }) });

function task(title: string, fields: Partial<Omit<ReviewTask, 'path' | 'title'>> = {}): ReviewTask {
  return {
    path: createVaultPath(`Tasks/${title}.md`),
    title,
    status: 'next-action',
    due: null,
    defer: null,
    waitingOn: '',
    contexts: [],
    project: null,
    projectTitle: null,
    modified: NOW,
    ...fields,
  };
}

const titlesIn = (tasks: readonly ReviewTask[], id: TodaySectionId, moment = at()) =>
  todayLists({ tasks, projects: [], at: moment })
    .sections.find((section) => section.id === id)
    ?.groups.flatMap((group) => group.tasks.map((each) => each.title)) ?? [];

describe('a timed due on the Today page', () => {
  const call = task('Call Mara Quill', { due: TODAY, dueTime: '15:30' });

  it('is due today until its time has passed, then overdue', () => {
    expect(titlesIn([call], 'dueToday', at('15:29'))).toEqual(['Call Mara Quill']);
    expect(titlesIn([call], 'overdue', at('15:29'))).toEqual([]);
    expect(titlesIn([call], 'dueToday', at('15:30'))).toEqual(['Call Mara Quill']);
    expect(titlesIn([call], 'overdue', at('15:31'))).toEqual(['Call Mara Quill']);
    expect(titlesIn([call], 'dueToday', at('15:31'))).toEqual([]);
  });

  it('is due today, by its day, when the read did not know the time', () => {
    expect(titlesIn([call], 'dueToday', at())).toEqual(['Call Mara Quill']);
  });

  it('leaves a date-only due today due today all day, as before', () => {
    const plain = task('Pay Larkspur Payroll', { due: TODAY });
    expect(titlesIn([plain], 'dueToday', at('23:59'))).toEqual(['Pay Larkspur Payroll']);
    expect(titlesIn([plain], 'overdue', at('23:59'))).toEqual([]);
  });

  it('is overdue on a later day, whatever the time, as a date-only due is', () => {
    const late = task('Write to Tobias Fenn', { due: '2026-12-03', dueTime: '23:00' });
    expect(titlesIn([late], 'overdue', at('00:00'))).toEqual(['Write to Tobias Fenn']);
  });

  it('is not overdue on a status that does not promise its day', () => {
    const someday = task('Someday call', { due: TODAY, dueTime: '08:00', status: 'someday' });
    expect(titlesIn([someday], 'overdue', at('12:00'))).toEqual([]);
  });

  it('orders due today with the date-only ones first, then by time, then by title', () => {
    const tasks = [
      task('Late call', { due: TODAY, dueTime: '17:00' }),
      task('Banking', { due: TODAY }),
      task('Early call', { due: TODAY, dueTime: '09:00' }),
      task('Another nine', { due: TODAY, dueTime: '09:00' }),
      task('Admin', { due: TODAY }),
    ];
    expect(titlesIn(tasks, 'dueToday', at('08:00'))).toEqual([
      'Admin',
      'Banking',
      'Another nine',
      'Early call',
      'Late call',
    ]);
  });

  it('orders overdue by day, and within a day a date-only due before the timed ones', () => {
    const tasks = [
      task('Today at nine', { due: TODAY, dueTime: '09:00' }),
      task('Yesterday at ten', { due: '2026-12-03', dueTime: '10:00' }),
      task('Yesterday', { due: '2026-12-03' }),
    ];
    expect(titlesIn(tasks, 'overdue', at('12:00'))).toEqual([
      'Yesterday',
      'Yesterday at ten',
      'Today at nine',
    ]);
  });
});

describe('the next time a due turns overdue', () => {
  const page = (tasks: readonly ReviewTask[], time: string) =>
    todayLists({ tasks, projects: [], at: at(time) });

  it('is the earliest time due today not yet passed', () => {
    const tasks = [
      task('Nine', { due: TODAY, dueTime: '09:00' }),
      task('Five', { due: TODAY, dueTime: '17:00' }),
      task('Noon', { due: TODAY, dueTime: '12:00' }),
      task('Tomorrow', { due: '2026-12-05', dueTime: '08:00' }),
      task('Date only', { due: TODAY }),
    ];
    expect(nextDueTurn(page(tasks, '10:00'), { today: TODAY, time: '10:00' })).toBe('12:00');
    // A time that is now is not yet passed: it turns the minute after.
    expect(nextDueTurn(page(tasks, '12:00'), { today: TODAY, time: '12:00' })).toBe('12:00');
    expect(nextDueTurn(page(tasks, '17:01'), { today: TODAY, time: '17:01' })).toBeNull();
  });

  it('is none when nothing due today names a time', () => {
    const tasks = [task('Date only', { due: TODAY }), task('No due')];
    expect(nextDueTurn(page(tasks, '10:00'), { today: TODAY, time: '10:00' })).toBeNull();
  });
});

describe('a timed due in the weekly review', () => {
  it('is overdue once its time today has passed, and the list is ordered within its day', () => {
    const tasks = [
      task('Today at nine', { due: TODAY, dueTime: '09:00' }),
      task('Today at five', { due: TODAY, dueTime: '17:00' }),
      task('Yesterday', { due: '2026-12-03' }),
    ];
    const overdue = weeklyReview({ tasks, projects: [], at: at('12:00') }).overdue;
    expect(overdue.map((each) => each.title)).toEqual(['Yesterday', 'Today at nine']);
  });
});
