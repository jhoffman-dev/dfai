import { describe, expect, it } from 'vitest';
import {
  compareDues,
  dueOf,
  dueTimeOfDated,
  dueWithTime,
  isPastDue,
  isWallTime,
  wallTimeOf,
  writtenDue,
  type TaskDue,
} from './task-due.ts';

/** #928: a due is a day, or a day with a wall-clock time (ADR-0029's addendum). */
const TODAY = '2026-12-04';
const day = (on: string): TaskDue => ({ day: on, time: null });
const at = (on: string, time: string): TaskDue => ({ day: on, time });

describe('what a due is read as', () => {
  it('is its day, with no time, when it names only the day', () => {
    expect(dueOf('2026-12-04')).toEqual(day('2026-12-04'));
  });

  it('carries the time written after the day, with a T or a space', () => {
    expect(dueOf('2026-12-04T15:30')).toEqual(at('2026-12-04', '15:30'));
    expect(dueOf('2026-12-04 15:30')).toEqual(at('2026-12-04', '15:30'));
  });

  it('reads seconds or a zone after the minutes as the same clock time, never converted', () => {
    expect(dueOf('2026-12-04T15:30:59')).toEqual(at('2026-12-04', '15:30'));
    expect(dueOf('2026-12-04T23:30Z')).toEqual(at('2026-12-04', '23:30'));
    expect(dueOf('2026-12-04T00:15+09:00')).toEqual(at('2026-12-04', '00:15'));
  });

  it('is no due for what the index does not date: words, an impossible day, nothing', () => {
    for (const none of ['tomorrow', '2026-02-30', '2026-12-04 at 3pm', '', null, undefined, 42]) {
      expect(dueOf(none)).toBeNull();
    }
  });

  it('is the first dated item of a list, as the index reads one', () => {
    expect(dueOf(['soon', '2026-12-04T09:00', '2026-12-05'])).toEqual(at('2026-12-04', '09:00'));
  });

  it('reads an index row’s dated value, and none from a row that carries none', () => {
    expect(dueTimeOfDated('2026-12-04T07:05')).toBe('07:05');
    expect(dueTimeOfDated('2026-12-04')).toBeNull();
    expect(dueTimeOfDated(null)).toBeNull();
    expect(dueTimeOfDated('')).toBeNull();
  });
});

describe('when a due has passed', () => {
  const now = (time: string) => ({ today: TODAY, time });

  it('a timed due today has passed once its minute has gone by, not before', () => {
    const due = at(TODAY, '15:30');
    expect(isPastDue(due, now('15:29'))).toBe(false);
    expect(isPastDue(due, now('15:30'))).toBe(false);
    expect(isPastDue(due, now('15:31'))).toBe(true);
  });

  it('a date-only due today has not passed until its day ends, whatever the time', () => {
    expect(isPastDue(day(TODAY), now('23:59'))).toBe(false);
    expect(isPastDue(day('2026-12-03'), now('00:00'))).toBe(true);
  });

  it('at midnight, yesterday’s last minute has passed and today’s first has not', () => {
    expect(isPastDue(at('2026-12-03', '23:59'), now('00:00'))).toBe(true);
    expect(isPastDue(at(TODAY, '00:00'), now('00:00'))).toBe(false);
    expect(isPastDue(at(TODAY, '00:00'), now('00:01'))).toBe(true);
  });

  it('a later day has not passed, whatever its time', () => {
    expect(isPastDue(at('2026-12-05', '00:00'), now('23:59'))).toBe(false);
    expect(isPastDue(day('2026-12-05'), now('23:59'))).toBe(false);
  });

  it('without the wall time a timed due today has not passed: its day decides, as before #928', () => {
    expect(isPastDue(at(TODAY, '00:01'), { today: TODAY })).toBe(false);
    expect(isPastDue(at('2026-12-03', '23:00'), { today: TODAY })).toBe(true);
  });

  it('reads the clock as written on the days the clocks change: no hour is converted', () => {
    // Spring forward (02:00 to 03:00): a due at 02:30, a time the clock skips, has passed at 03:00.
    expect(isPastDue(at('2027-03-14', '02:30'), { today: '2027-03-14', time: '03:00' })).toBe(true);
    // Fall back: 01:30 has passed at the first 01:45, and reads as the clock says in the repeat.
    expect(isPastDue(at('2026-11-01', '01:30'), { today: '2026-11-01', time: '01:45' })).toBe(true);
    expect(isPastDue(at('2026-11-01', '01:30'), { today: '2026-11-01', time: '01:10' })).toBe(
      false,
    );
  });

  it('takes the wall time from the clock’s local now', () => {
    expect(wallTimeOf('2026-12-04T15:31:07')).toBe('15:31');
    expect(wallTimeOf('not a time')).toBeNull();
    expect(wallTimeOf('2026-12-04')).toBeNull();
  });
});

describe('the order of dues', () => {
  it('is by day, then a date-only due before the timed ones on its day, those by time', () => {
    const dues = [
      at('2026-12-05', '08:00'),
      null,
      at(TODAY, '15:30'),
      day('2026-12-05'),
      at(TODAY, '09:00'),
      day(TODAY),
      at('2026-12-03', '23:00'),
    ];
    expect(dues.sort(compareDues)).toEqual([
      at('2026-12-03', '23:00'),
      day(TODAY),
      at(TODAY, '09:00'),
      at(TODAY, '15:30'),
      day('2026-12-05'),
      at('2026-12-05', '08:00'),
      null,
    ]);
  });

  it('is the order the written text sorts in, as the query language sorts `due`', () => {
    const written = ['2026-12-04T15:30', '2026-12-05', '2026-12-04', '2026-12-04T09:00'];
    const byText = [...written].sort();
    const byRule = [...written].sort((left, right) => compareDues(dueOf(left), dueOf(right)));
    expect(byRule).toEqual(byText);
  });

  it('holds equal dues equal', () => {
    expect(compareDues(at(TODAY, '10:00'), at(TODAY, '10:00'))).toBe(0);
    expect(compareDues(day(TODAY), day(TODAY))).toBe(0);
    expect(compareDues(null, null)).toBe(0);
  });
});

describe('writing a due', () => {
  it('writes the day alone, or the day and its time with a T', () => {
    expect(writtenDue(day(TODAY))).toBe('2026-12-04');
    expect(writtenDue(at(TODAY, '15:30'))).toBe('2026-12-04T15:30');
  });

  it('sets a time on the day written, replaces one, and takes it off back to the day', () => {
    expect(dueWithTime('2026-12-04', '15:30')).toBe('2026-12-04T15:30');
    expect(dueWithTime('2026-12-04T15:30', '09:05')).toBe('2026-12-04T09:05');
    expect(dueWithTime('2026-12-04T15:30', null)).toBe('2026-12-04');
    expect(dueWithTime('2026-12-04 15:30', null)).toBe('2026-12-04');
  });

  it('sets then clears back to the date-only text it started from', () => {
    const timed = dueWithTime('2026-12-04', '07:45');
    expect(dueWithTime(timed, null)).toBe('2026-12-04');
  });

  it('gives no write for a value that holds no due', () => {
    expect(dueWithTime('next week', '15:30')).toBeNull();
    expect(dueWithTime(null, null)).toBeNull();
  });

  it('takes a time of 00:00 to 23:59 written HH:MM, and nothing else', () => {
    for (const time of ['00:00', '09:05', '15:30', '23:59']) expect(isWallTime(time)).toBe(true);
    for (const time of ['24:00', '9:05', '15:60', '15:30:00', '', 'noon']) {
      expect(isWallTime(time)).toBe(false);
    }
  });
});
