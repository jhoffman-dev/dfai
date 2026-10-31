import { describe, expect, it } from 'vitest';
import { nextOccurrence, parseRecurrence } from './recurrence.ts';

describe('parseRecurrence', () => {
  it.each([
    ['daily', { unit: 'day', every: 1 }],
    ['every day', { unit: 'day', every: 1 }],
    ['weekly', { unit: 'week', every: 1 }],
    ['monthly', { unit: 'month', every: 1 }],
    ['yearly', { unit: 'year', every: 1 }],
    ['annually', { unit: 'year', every: 1 }],
  ])('reads %j', (value, expected) => {
    expect(parseRecurrence(value)).toEqual(expected);
  });

  it.each([
    ['every 3 days', { unit: 'day', every: 3 }],
    ['every 2 weeks', { unit: 'week', every: 2 }],
    ['every 6 months', { unit: 'month', every: 6 }],
    ['every 1 day', { unit: 'day', every: 1 }],
  ])('reads %j', (value, expected) => {
    expect(parseRecurrence(value)).toEqual(expected);
  });

  it('ignores case and stray spacing', () => {
    expect(parseRecurrence('  Every  2   Weeks ')).toEqual({ unit: 'week', every: 2 });
  });

  it.each([
    null,
    undefined,
    42,
    '',
    '   ',
    'sometimes',
    'every 0 days',
    'every -1 day',
    'every fortnight',
  ])('returns nothing for %j', (value) => {
    expect(parseRecurrence(value)).toBeNull();
  });
});

describe('nextOccurrence', () => {
  it('adds a day', () => {
    expect(nextOccurrence('2026-09-20', { unit: 'day', every: 1 })).toBe('2026-09-21');
  });

  it('adds several days, crossing a month', () => {
    expect(nextOccurrence('2026-09-28', { unit: 'day', every: 5 })).toBe('2026-10-03');
  });

  it('adds a week', () => {
    expect(nextOccurrence('2026-09-20', { unit: 'week', every: 1 })).toBe('2026-09-27');
  });

  it('adds a month', () => {
    expect(nextOccurrence('2026-09-20', { unit: 'month', every: 1 })).toBe('2026-10-20');
  });

  it('lands on the last day when the next month is shorter', () => {
    expect(nextOccurrence('2026-01-31', { unit: 'month', every: 1 })).toBe('2026-02-28');
  });

  it('handles a leap year', () => {
    expect(nextOccurrence('2028-01-31', { unit: 'month', every: 1 })).toBe('2028-02-29');
  });

  it('adds a year', () => {
    expect(nextOccurrence('2026-09-20', { unit: 'year', every: 1 })).toBe('2027-09-20');
  });

  it('moves a leap day to the 28th in a common year', () => {
    expect(nextOccurrence('2028-02-29', { unit: 'year', every: 1 })).toBe('2029-02-28');
  });

  it('counts from when it was due, not from today', () => {
    // Finished late; the next one is still a week after it was due.
    expect(nextOccurrence('2026-09-01', { unit: 'week', every: 1 })).toBe('2026-09-08');
  });

  it('ignores a time on the date', () => {
    expect(nextOccurrence('2026-09-20T10:00:00Z', { unit: 'day', every: 1 })).toBe('2026-09-21');
  });

  it.each(['', 'soon', '20/09/2026'])('returns nothing for %j', (from) => {
    expect(nextOccurrence(from, { unit: 'day', every: 1 })).toBeNull();
  });
});

describe('nextOccurrence at the last day a date can hold', () => {
  it.each([
    ['day', '9999-12-31'],
    ['week', '9999-12-30'],
    ['month', '9999-12-15'],
    ['year', '9999-06-01'],
  ] as const)('has no next %s past 9999-12-31', (unit, from) => {
    expect(nextOccurrence(from, { unit, every: 1 })).toBeNull();
  });
});

describe('parseRecurrence reads a list by the one-value rule (#107, as PR #616)', () => {
  it('reads one rule written as a list, a blank item being no item', () => {
    expect(parseRecurrence(['every week'])).toEqual({ unit: 'week', every: 1 });
    expect(parseRecurrence(['', 'every week'])).toEqual({ unit: 'week', every: 1 });
    expect(parseRecurrence([' daily ', null])).toEqual({ unit: 'day', every: 1 });
  });

  it('reads no rule from two, nested or not, nor from nothing but blanks', () => {
    expect(parseRecurrence(['every week', 'every day'])).toBeNull();
    expect(parseRecurrence([['every week', 'every day']])).toBeNull();
    expect(parseRecurrence(['', ''])).toBeNull();
    expect(parseRecurrence([])).toBeNull();
  });
});
