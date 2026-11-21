/**
 * A task's due (#928): a day, and a time of day when one is written with it.
 *
 * `due` is written `2026-12-04` or `2026-12-04T15:30`. The time is local
 * wall-clock time with no zone, read as the calendar reads a timeblock's
 * `start` (ADR-0030, `readEventTime`): a space for the `T`, seconds or a zone
 * after the minutes are read as the same clock time, never converted. The day
 * is the first ten characters the index dates the value by (`value_date`), so
 * every query, sort and filter that reads the day reads it as before.
 *
 * This module is the one answer to "is this task overdue?" and "which comes
 * first?" for every surface that can ask it: Today, the weekly review, the
 * assistant's items, a calendar of tasks by due. The query language cannot
 * (it compares `value_date` by day in SQL; #932).
 */
import { clockLabel, readEventTime } from '../calendar/calendar-event.ts';
import { indexablePropertiesOf } from '../index/property-value.ts';
import { TASK_KEYS, TASK_TYPE } from './gtd-status.ts';

export interface TaskDue {
  /** `YYYY-MM-DD`. */
  readonly day: string;
  /**
   * `HH:MM`, wall-clock time; null for a due that names only its day, and
   * for one whose time is no clock time (`T24:00`): that is read as its day.
   */
  readonly time: string | null;
  /**
   * What it sorts by: the text as the index dates it, a space read as `T` —
   * the key the query language's sort uses (`field-sql.ts`), so a table
   * sorted by due and Today order dues alike, seconds and `T24:00` included.
   */
  readonly order: string;
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
  const dated = datedDueOf(value);
  return dated === null ? null : dueOfDated(dated);
}

/** The first item of a value the index dates, as it dates it (`value_date`); null when none. */
export function datedDueOf(value: unknown): string | null {
  return indexablePropertiesOf({ due: value }).find((row) => row.date !== null)?.date ?? null;
}

/** A due from a value the index dated (`value_date`), which always starts with its day. */
export function dueOfDated(dated: string): TaskDue {
  const minutes = readEventTime(dated)?.minutes ?? null;
  return {
    day: dated.slice(0, 10),
    time: minutes === null ? null : clockLabel(minutes),
    order: dated.replaceAll(' ', 'T'),
  };
}

/** A due the app writes: its day, and its time when it has one. */
export function dueAt(day: string, time: string | null): TaskDue {
  return { day, time, order: time === null ? day : `${day}T${time}` };
}

/** The time of a dated value as an index row carries it; null for none, or no row. */
export function dueTimeOfDated(dated: unknown): string | null {
  return typeof dated === 'string' && dated !== '' ? dueOfDated(dated).time : null;
}

/**
 * Earlier first, by {@link TaskDue.order}, compared as SQLite compares text:
 * by day; within a day a date-only due ("sometime that day") before the
 * timed ones, those by time, and within a minute by what follows it (09:00
 * before 09:00:59); `T24:00` after 23:59. No due after every due.
 */
export function compareDues(left: TaskDue | null, right: TaskDue | null): number {
  if (left === null || right === null) return Number(left === null) - Number(right === null);
  if (left.order === right.order) return 0;
  return left.order < right.order ? -1 : 1;
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
  return due === null ? null : writtenDue(dueAt(due.day, time));
}

/**
 * A due moved to another day with whatever followed its day kept as written
 * — a time, seconds, a zone, `T24:00` — so a roll or a new day never drops or
 * rewrites it. A value that is no single written date becomes the day.
 */
export function dueOnDay(value: unknown, day: string): string {
  if (typeof value !== 'string' || dueOf(value) === null) return day;
  const written = value.trim();
  return `${day}${written.slice(10)}`;
}

/**
 * Whether a view's date field is a task's due, read by these rules: the
 * `due` of the Task type. A calendar of it says overdue as Today does.
 */
export function readsTaskDue({ typeName, dateKey }: { typeName: string | null; dateKey: string }) {
  return (
    typeName !== null && typeName.trim().toLowerCase() === TASK_TYPE && dateKey === TASK_KEYS.due
  );
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
