/**
 * Notes as calendar events: when each starts, when it ends, and which days it
 * is on.
 *
 * A date property holds either a day (`2026-09-22`) or a day and a time
 * (`2026-09-22T14:30`). A day is an all-day event; a time puts the note on the
 * day's clock. The time is read as written — wall-clock time where the person
 * is — so nothing here converts between zones, and a day never moves across
 * midnight because of where the machine thinks it is.
 */
import type { BoardRow } from '../query/group-rows.ts';
import { addDays, daysBetween } from '../timeline/timeline.ts';
import { dateParts } from './calendar-range.ts';

export const MINUTES_PER_DAY = 1440;

/** How long a timed note with no end is drawn, and resized from. */
export const DEFAULT_DURATION = 30;

/** The longest stretch a note is drawn across, so a typo'd year does not fill every day. */
const LONGEST_SPAN_DAYS = 366;

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})(?:([T ])(\d{2}):(\d{2})(.*))?$/;

/** A date property as the calendar reads it. */
export interface EventTime {
  readonly date: string;
  /** Minutes after midnight, or null for a day with no time. */
  readonly minutes: number | null;
}

export interface CalendarEvent {
  readonly path: string;
  readonly title: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly start: EventTime;
  /** Null when the view has no end property, the note leaves it empty, or it ends before it starts. */
  readonly end: EventTime | null;
}

/** A date or date-time as written, or null for anything that is not a real one. */
export function readEventTime(value: unknown): EventTime | null {
  if (typeof value !== 'string') return null;
  const match = DATE_TIME.exec(value.trim());
  const date = match?.[1];
  if (match === null || date === undefined || dateParts(date) === null) return null;
  if (match[3] === undefined) return { date, minutes: null };
  const hours = Number(match[3]);
  const minutes = Number(match[4]);
  if (hours > 23 || minutes > 59) return null;
  return { date, minutes: hours * 60 + minutes };
}

/** Minutes from one moment to another, both as wall-clock times. A day counts as its midnight. */
export function minutesBetween(from: EventTime, to: EventTime): number {
  return (
    daysBetween(from.date, to.date) * MINUTES_PER_DAY + (to.minutes ?? 0) - (from.minutes ?? 0)
  );
}

/**
 * The property a calendar reads each note's end from: the timeline's end,
 * when the view's timeline starts on the same date the calendar places notes
 * by. Null when there is none, and each note is a moment or a single day.
 */
export function calendarEndKey({
  dateKey,
  startKey,
  endKey,
}: {
  dateKey: string;
  startKey: string | null;
  endKey: string | null;
}): string | null {
  if (endKey === null || endKey === dateKey || startKey !== dateKey) return null;
  return endKey;
}

/** The rows with a readable date as events; the rest are counted, not shown. */
export function calendarEvents({
  rows,
  dateKey,
  endKey,
  readStart = readEventTime,
}: {
  rows: readonly BoardRow[];
  dateKey: string;
  endKey: string | null;
  /**
   * How each note's start is read: as written (`readEventTime`), or, in a
   * calendar of tasks by their due, as the due rules read a due (#928,
   * `dueEventTime`), so it is on the day every other surface puts it.
   */
  readStart?: (value: unknown) => EventTime | null;
}): { events: CalendarEvent[]; unscheduled: number } {
  const events: CalendarEvent[] = [];
  for (const row of rows) {
    const start = readStart(row.values[dateKey]);
    if (start === null) continue;
    const end = endKey === null ? null : readEventTime(row.values[endKey]);
    const ordered = end !== null && minutesBetween(start, end) >= 0 ? end : null;
    events.push({ path: row.path, title: row.title, values: row.values, start, end: ordered });
  }
  return { events, unscheduled: rows.length - events.length };
}

/** Whether the note is on the clock rather than all day. */
export function isTimed(event: CalendarEvent): boolean {
  return event.start.minutes !== null;
}

/**
 * When a timed note ends: its end when that is later, else the default
 * duration after it starts. An all-day note ends at the end of its last day.
 */
export function effectiveEnd(event: CalendarEvent): EventTime {
  const { start, end } = event;
  if (start.minutes === null) return { date: lastDay(event), minutes: MINUTES_PER_DAY };
  if (end !== null && end.minutes !== null && minutesBetween(start, end) > 0) return end;
  if (end !== null && end.minutes === null && end.date !== start.date) {
    return { date: end.date, minutes: MINUTES_PER_DAY };
  }
  const total = start.minutes + DEFAULT_DURATION;
  if (total <= MINUTES_PER_DAY) return { date: start.date, minutes: total };
  const nextDay = addDays(start.date, 1);
  // A note late on 9999-12-31 has no next day to run into, so it ends with its own.
  if (nextDay === null) return { date: start.date, minutes: MINUTES_PER_DAY };
  return { date: nextDay, minutes: total - MINUTES_PER_DAY };
}

/** The last day the note is on. */
function lastDay(event: CalendarEvent): string {
  const end = event.end?.date ?? event.start.date;
  const span = Math.min(daysBetween(event.start.date, end), LONGEST_SPAN_DAYS);
  // Never null: the span is at most the days to an end date that was read.
  return addDays(event.start.date, Math.max(0, span)) ?? end;
}

/**
 * The part of a day a timed note covers, in minutes after midnight, or null
 * when it is not on the clock that day. A note running past midnight is drawn
 * to the end of its first day and from the start of the next.
 */
export function daySpan(event: CalendarEvent, date: string): { from: number; to: number } | null {
  if (!isTimed(event)) return null;
  const startMinutes = event.start.minutes ?? 0;
  const end = effectiveEnd(event);
  const offset = daysBetween(event.start.date, date);
  const lastOffset = Math.min(daysBetween(event.start.date, end.date), LONGEST_SPAN_DAYS);
  if (offset < 0 || offset > lastOffset) return null;
  const from = offset === 0 ? startMinutes : 0;
  const to = offset === lastOffset ? (end.minutes ?? MINUTES_PER_DAY) : MINUTES_PER_DAY;
  return to > from ? { from, to } : null;
}

/** Whether the note is on this day, all day or for part of it. */
export function occursOn(event: CalendarEvent, date: string): boolean {
  if (isTimed(event)) return daySpan(event, date) !== null;
  const offset = daysBetween(event.start.date, date);
  return offset >= 0 && offset <= daysBetween(event.start.date, lastDay(event));
}

/** All-day notes first, then by the time they start, then by name. */
export function byTimeOfDay(left: CalendarEvent, right: CalendarEvent): number {
  const leftStart = left.start.minutes ?? -1;
  const rightStart = right.start.minutes ?? -1;
  if (leftStart !== rightStart) return leftStart - rightStart;
  return left.title.localeCompare(right.title) || left.path.localeCompare(right.path);
}

/** The notes on a day, in the order a day lists them. */
export function eventsOn(events: readonly CalendarEvent[], date: string): CalendarEvent[] {
  return events.filter((event) => occursOn(event, date)).sort(byTimeOfDay);
}

/** A note on a range of days, and the ones of them it is on. */
export interface EventInRange {
  readonly event: CalendarEvent;
  readonly on: readonly string[];
}

/**
 * The notes on any of `days`, each with the days it is on: in the order the
 * range shows them — by the first of those days, then as a day lists them.
 */
export function eventsInDays({
  events,
  days,
}: {
  events: readonly CalendarEvent[];
  days: readonly string[];
}): EventInRange[] {
  const placed = events
    .map((event) => ({ event, on: days.filter((date) => occursOn(event, date)) }))
    .filter(({ on }) => on.length > 0);
  const firstDay = (entry: EventInRange) => days.indexOf(entry.on[0] ?? '');
  return placed.sort(
    (left, right) => firstDay(left) - firstDay(right) || byTimeOfDay(left.event, right.event),
  );
}

/** "14:30". */
export function clockLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * When a note is, on a given day, in words for a list: "All day", "14:30",
 * or "14:30 – 15:00" when the note says when it ends.
 */
export function timeLabel(event: CalendarEvent, date: string): string {
  const span = daySpan(event, date);
  if (span === null) return 'All day';
  const from = clockLabel(span.from);
  if (event.end === null) return from;
  return `${from} – ${span.to === MINUTES_PER_DAY ? '24:00' : clockLabel(span.to)}`;
}

/**
 * What fits in a month's day: every note when they fit, else one fewer than
 * fits and "+N more" in the last row, so the day never grows or scrolls.
 */
export function dayOverflow<T>(
  entries: readonly T[],
  rows: number,
): { shown: readonly T[]; hidden: readonly T[] } {
  if (entries.length <= rows) return { shown: entries, hidden: [] };
  const fits = Math.max(0, rows - 1);
  return { shown: entries.slice(0, fits), hidden: entries.slice(fits) };
}
