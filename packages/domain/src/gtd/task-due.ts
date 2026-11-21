/**
 * A task's due (#928): a day, and a time of day when one is written with it.
 *
 * `due` is written `2026-12-04` or `2026-12-04T15:30`. The time is local
 * wall-clock time with no zone, read as the calendar reads a timeblock's
 * `start` (ADR-0030, `readEventTime`): a space for the `T`, seconds or a zone
 * after the minutes are read as the same clock time, never converted. The day
 * is the first ten characters the index dates the value by (`value_date`), so
 * every query, sort and filter that reads the day reads it as before.
 */
import { clockLabel, readEventTime } from '../calendar/calendar-event.ts';
import { indexablePropertiesOf } from '../index/property-value.ts';

export interface TaskDue {
  /** `YYYY-MM-DD`. */
  readonly day: string;
  /** `HH:MM`, wall-clock time; null for a due that names only its day. */
  readonly time: string | null;
}

/** The moment the due rules are measured against, from the injected clock. */
export interface DueMoment {
  /** `YYYY-MM-DD`. */
  readonly today: string;
  /**
   * `HH:MM`, wall-clock time. Absent where the clock was not asked: a timed
   * due today is then not yet past, as every due was before #928.
   */
  readonly time?: string | null;
}

/** The due a frontmatter value holds: its first item the index dates; null when none. */
export function dueOf(value: unknown): TaskDue | null {
  const dated = indexablePropertiesOf({ due: value }).find((row) => row.date !== null)?.date;
  return dated === undefined || dated === null ? null : dueOfDated(dated);
}

/** A due from a value the index dated (`value_date`), which always starts with its day. */
export function dueOfDated(dated: string): TaskDue {
  const minutes = readEventTime(dated)?.minutes ?? null;
  return { day: dated.slice(0, 10), time: minutes === null ? null : clockLabel(minutes) };
}

/** The time of a dated value as an index row carries it; null for none, or no row. */
export function dueTimeOfDated(dated: unknown): string | null {
  return typeof dated === 'string' && dated !== '' ? dueOfDated(dated).time : null;
}

/**
 * Earlier first, by day; within a day a date-only due ("sometime that day")
 * before the timed ones, and those by time — the order the query language
 * sorts `due` in, by the text as written. No due after every due.
 */
export function compareDues(left: TaskDue | null, right: TaskDue | null): number {
  if (left === null || right === null) return Number(left === null) - Number(right === null);
  return left.day.localeCompare(right.day) || compareTimes(left.time, right.time);
}

function compareTimes(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left.localeCompare(right);
}

/**
 * Whether a due has passed: its day is before today, or it is today and its
 * time has gone by — 15:30 is past from 15:31. A date-only due passes when
 * its day ends. Wall-clock time throughout: on the night the clocks go back,
 * the repeated hour reads as the clock says.
 */
export function isPastDue(due: TaskDue, at: DueMoment): boolean {
  if (due.day !== at.today) return due.day < at.today;
  return due.time !== null && typeof at.time === 'string' && at.time > due.time;
}

/** A due as the app writes it: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` with its time. */
export function writtenDue(due: TaskDue): string {
  return due.time === null ? due.day : `${due.day}T${due.time}`;
}

/**
 * The due written with its time set, or taken off when `time` is null —
 * its day kept. Null when the value holds no due to give a time to.
 */
export function dueWithTime(value: unknown, time: string | null): string | null {
  const due = dueOf(value);
  return due === null ? null : writtenDue({ day: due.day, time });
}

/** Whether `text` is a wall-clock time as a due holds one, `HH:MM` from 00:00 to 23:59. */
export function isWallTime(text: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(text);
}

/** `HH:MM` of a wall-clock moment written `YYYY-MM-DDTHH:MM[:SS]` (`Clock.localNow`); null when it is not one. */
export function wallTimeOf(localNow: string): string | null {
  const minutes = readEventTime(localNow)?.minutes ?? null;
  return minutes === null ? null : clockLabel(minutes);
}
