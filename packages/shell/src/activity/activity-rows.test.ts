import { describe, expect, it } from 'vitest';
import { createVaultPath, type ActivityEvent } from '@dfai/domain';
import { activityRows, shownTime, subjectOf } from './activity-rows.ts';
import { eventDetails } from './event-details.ts';

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

  it('shows each line as given, its subject named for its link, its id its own', () => {
    expect(activityRows(events, TODAY)).toEqual([
      {
        id: expect.any(String),
        time: 'Today, 14:03',
        dateTime: '2026-09-28T14:03:00',
        level: 'error',
        kind: 'save',
        message: 'b',
        subject: null,
        // An error opens to its details (#815); the line of news below does not.
        details: eventDetails(events[0] as ActivityEvent, TODAY),
      },
      {
        id: expect.any(String),
        time: 'Today, 03:00',
        dateTime: '2026-09-28T03:00:00',
        level: 'info',
        kind: 'automation',
        message: 'a',
        subject: 'Tidy tasks',
      },
    ]);
  });

  const idOf = (index: number) => activityRows(events, TODAY)[index]?.id ?? '';

  it('finds what a row links to by its id, and nothing for an id it does not know', () => {
    expect(subjectOf(events, idOf(1))).toEqual({ kind: 'rule', path: RULE });
    expect(subjectOf(events, idOf(0))).toBeNull();
    expect(subjectOf(events, '7')).toBeNull();
  });

  it('keeps each line its id when newer lines arrive and the oldest go (#815)', () => {
    const [newest, oldest] = events as [ActivityEvent, ActivityEvent];
    const middle: ActivityEvent = { ...newest, at: newest.at - 1000, message: 'm' };
    const before = activityRows([newest, middle, oldest], TODAY).map((row) => row.id);
    const arrived: ActivityEvent = { ...newest, at: newest.at + 1000, message: 'n' };
    const after = activityRows([arrived, newest, middle], TODAY).map((row) => row.id);

    expect(new Set(before).size).toBe(3);
    expect(after.slice(1)).toEqual(before.slice(0, 2));
    expect(subjectOf([arrived, newest, oldest], before[2] ?? '')).toEqual({
      kind: 'rule',
      path: RULE,
    });
  });

  it('tells two lines of the same moment and words apart', () => {
    const [newest] = events as [ActivityEvent];
    const ids = activityRows([newest, newest, { ...newest, message: 'c' }], TODAY).map(
      (row) => row.id,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it('hands a trimmed twin’s id to the twin left: the one case where an id moves (#815)', () => {
    const [newest] = events as [ActivityEvent];
    const [younger, older] = activityRows([newest, newest], TODAY).map((row) => row.id);
    expect(younger).not.toBe(older);

    // The older twin is trimmed. Nothing in an event tells the two apart, so the id stays with the words.
    const [left] = activityRows([newest], TODAY).map((row) => row.id);
    expect(left).toBe(older);
  });
});
