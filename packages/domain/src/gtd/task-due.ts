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
import { clockLabel, readEventTime, type EventTime } from '../calendar/calendar-event.ts';
import { movedEvent, type EventWrite } from '../calendar/event-move.ts';
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

/**
 * The items a due holds, as the indexer stores them (`toIndexableProperties`):
 * a list flattened at any depth, each item a row; a blank — null, empty, spaces,
 * an empty list — no item, as the index counts them (`singleDatedSql`). A
 * mapping, a number or `true` is an item, and no text.
 */
function dueEntries(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value.flatMap(dueEntries);
  const blank =
    value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  return blank ? [] : [value];
}

/**
 * The one entry a due holds, as written (PR #930): what is left once blanks
 * are dropped, when that is exactly one text — `2026-12-04T15:30`, or
 * `[2026-12-04T15:30]`, or `['', 2026-12-04T15:30]`. Null for several, for
 * none, and for a mapping, a number or `true`. The only place that decides
 * whether a due is one value: every reader and every action asks it.
 */
export function oneDueEntry(value: unknown): string | null {
  const entries = dueEntries(value);
  const [only] = entries;
  return entries.length === 1 && typeof only === 'string' ? only.trim() : null;
}

/** Whether a due holds several entries, blanks aside: never one due, with no time read. */
export function holdsSeveralDues(value: unknown): boolean {
  return dueEntries(value).length > 1;
}

/**
 * The due a value holds, read with its time: its one entry (`oneDueEntry`),
 * where the index dates it; null for anything else.
 */
export function dueOf(value: unknown): TaskDue | null {
  const entry = oneDueEntry(value);
  const dated = entry === null ? null : datedDueOf(entry);
  return dated === null ? null : dueOfDated(dated);
}

/**
 * The due a value is judged by — Today, the review, the assistant: its one
 * entry with its time (`dueOf`); a due of several entries by the first day
 * the index dates among them, with no time, as before #928. Null for none.
 */
export function judgedDue(value: unknown): TaskDue | null {
  if (oneDueEntry(value) !== null) return dueOf(value);
  const dated = datedDueOf(value);
  return dated === null ? null : dueAt(dated.slice(0, 10), null);
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

/**
 * A due as a calendar of tasks places it: on its day, at its time when it
 * has one, all day when it names only its day or a time that is no clock
 * time (`T24:00`) — as Today and every other surface read it. Null for a
 * value that holds no due, which such a calendar counts as unscheduled.
 */
export function dueEventTime(value: unknown): EventTime | null {
  // One entry only: a due of several is not on the calendar, where a move
  // would write one value over all of them.
  const due = dueOf(value);
  if (due === null) return null;
  if (due.time === null) return { date: due.day, minutes: null };
  const [hours, minutes] = due.time.split(':').map(Number) as [number, number];
  return { date: due.day, minutes: hours * 60 + minutes };
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
  const entry = oneDueEntry(value);
  if (entry === null || dueOf(entry) === null) return day;
  return `${day}${entry.slice(10)}`;
}

/**
 * A due the person moves to another day — in the properties panel, on an
 * Inbox row: its time of day kept as written; one the rules read as no time
 * (`T24:00`) is dropped, since it was just rescheduled. A value that is no
 * due becomes the day picked.
 */
export function dueRescheduled(value: unknown, day: string): string {
  const due = dueOf(value);
  return due === null || due.time === null ? day : dueOnDay(value, day);
}

/**
 * A due dragged on a calendar of tasks by due (`readsTaskDue`), as the due
 * rules read it: one with a time moves on the clock in its own shape
 * (`movedEvent`); one with none — a day, `T24:00` — moves by days as a day,
 * written `YYYY-MM-DD`. Its end, where the view has one, moves with it.
 */
export function movedDue(move: {
  start: unknown;
  end: string | null;
  days: number;
  minutes: number;
}): EventWrite | null {
  const entry = oneDueEntry(move.start);
  const due = entry === null ? null : dueOf(entry);
  if (entry === null || due === null) return null;
  return movedEvent({ ...move, start: due.time === null ? due.day : entry });
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
