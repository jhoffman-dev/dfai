import { describe, expect, it } from 'vitest';
import { createVaultPath, type ActivityEvent } from '@dfai/domain';
import { activityRows, shownTime, subjectOf } from './activity-rows.ts';

// Built from local parts, so the test reads the same in any timezone.
const local = (day: number, hour: number, minute: number, month = 8, year = 2026) =>
  new Date(year, month, day, hour, minute).getTime();
const TODAY = '2026-09-28';

describe('shownTime', () => {
  it('says today and yesterday by name', () => {
    expect(shownTime(local(28, 14, 3), TODAY)).toBe('Today, 14:03');
    expect(shownTime(local(27, 9, 5), TODAY)).toBe('Yesterday, 09:05');
  });

  it('dates an older line by day and month, and by year only when it is not this one', () => {
    expect(shownTime(local(2, 3, 0), TODAY)).toBe('2 Sep, 03:00');
    expect(shownTime(local(30, 23, 59, 11, 2025), TODAY)).toBe('30 Dec 2025, 23:59');
  });

  it('reads yesterday across a month', () => {
    expect(shownTime(local(30, 8, 0, 8), '2026-10-01')).toBe('Yesterday, 08:00');
  });
});

describe('activityRows', () => {
  const RULE = createVaultPath('.atlas/automations/Tidy tasks.md');
  const events: ActivityEvent[] = [
    { at: local(28, 14, 3), level: 'error', kind: 'save', message: 'b', subject: null },
    {
      at: local(28, 3, 0),
      level: 'info',
      kind: 'automation',
      message: 'a',
      subject: { kind: 'rule', path: RULE },
    },
  ];

  it('shows each line as given, its subject named for its link, its id counted from the oldest', () => {
    expect(activityRows(events, TODAY)).toEqual([
      {
        id: '1',
        time: 'Today, 14:03',
        dateTime: '2026-09-28T14:03:00',
        level: 'error',
        kind: 'save',
        message: 'b',
        subject: null,
      },
      {
        id: '0',
        time: 'Today, 03:00',
        dateTime: '2026-09-28T03:00:00',
        level: 'info',
        kind: 'automation',
        message: 'a',
        subject: 'Tidy tasks',
      },
    ]);
  });

  it('finds what a row links to by its id, and nothing for an id it does not know', () => {
    expect(subjectOf(events, '0')).toEqual({ kind: 'rule', path: RULE });
    expect(subjectOf(events, '1')).toBeNull();
    expect(subjectOf(events, '7')).toBeNull();
  });
});
