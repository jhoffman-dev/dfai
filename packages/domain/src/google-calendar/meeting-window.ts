import { wallClockIn } from '../meetings/mapping/meeting-when.ts';
import { addDays } from '../timeline/timeline.ts';
import type { EventWhen } from './google-event.ts';

/**
 * The days a meetings sync reads (ADR-0046): yesterday, so a meeting's notes
 * that arrive the morning after are still matched to it, today, and the week
 * ahead, so the calendar shows what is coming.
 */
export const MEETING_DAYS_BEFORE = 1;
export const MEETING_DAYS_AFTER = 6;

const HOUR_MS = 3_600_000;

/** The days read, on the person's wall clock, and the instants Google is asked between. */
export interface MeetingWindow {
  /** The first day, `YYYY-MM-DD`. */
  readonly fromDay: string;
  /** The last day, included. */
  readonly toDay: string;
  /** The first instant of `fromDay` where the person is, in milliseconds. */
  readonly timeMin: number;
  /** The first instant of the day after `toDay`. */
  readonly timeMax: number;
}

/** The day and time an instant shows, as `Date.UTC` would count them. */
function shownAsUtc(clock: ReturnType<typeof wallClockIn>, instant: number): number {
  const { day, time } = clock(instant);
  const [year, month, date] = day.split('-').map(Number);
  const [hours, minutes, seconds] = time.split(':').map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1, hours ?? 0, minutes ?? 0, seconds ?? 0);
}

/** How far `timeZone`'s clock is ahead of UTC at `instant`, in minutes. */
export function zoneOffsetMinutes(timeZone: string, instant: number): number {
  return Math.round((shownAsUtc(wallClockIn(timeZone), instant) - instant) / 60_000);
}

/**
 * The first instant of `day` in `timeZone`. Usually its midnight; on a day
 * whose midnight the clocks skip (Santiago's spring change), the instant
 * the day begins at instead. Tried with the zone's offset half a day either
 * side, so a change at any hour of the day is on one side of it.
 */
export function startOfDayIn(day: string, timeZone: string): number {
  const clock = wallClockIn(timeZone);
  const [year, month, date] = day.split('-').map(Number);
  const midnight = Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1);
  const candidates = [midnight - 14 * HOUR_MS, midnight + 14 * HOUR_MS]
    .map((near) => midnight - (shownAsUtc(clock, near) - near))
    .filter((instant) => clock(instant).day === day);
  return Math.min(...candidates);
}

/** The days a sync of `today` reads, or null when `today` is not a day. */
export function meetingWindow({
  today,
  timeZone,
}: {
  today: string;
  timeZone: string;
}): MeetingWindow | null {
  const fromDay = addDays(today, -MEETING_DAYS_BEFORE);
  const toDay = addDays(today, MEETING_DAYS_AFTER);
  const after = addDays(today, MEETING_DAYS_AFTER + 1);
  if (fromDay === null || toDay === null || after === null) return null;
  return {
    fromDay,
    toDay,
    timeMin: startOfDayIn(fromDay, timeZone),
    timeMax: startOfDayIn(after, timeZone),
  };
}

/**
 * When an event starts, as a note holds it: `2026-10-24T09:30` on the
 * person's wall clock, with no offset (ADR-0030), or `2026-10-24` all day.
 */
export function wallStart(when: EventWhen, timeZone: string): string {
  if (when.kind === 'day') return when.date;
  const { day, time } = wallClockIn(timeZone)(when.at);
  return `${day}T${time.slice(0, 5)}`;
}

/**
 * When an event ends, as a note holds it. Google ends an all-day event on
 * the day after its last; a note names its last day, as a calendar view
 * reads `ends`. Null when it ends the day it starts, which says nothing more.
 */
export function wallEnd(start: EventWhen, end: EventWhen | null, timeZone: string): string | null {
  if (end === null) return null;
  if (end.kind === 'timed') return wallStart(end, timeZone);
  const last = addDays(end.date, -1);
  const first = start.kind === 'day' ? start.date : null;
  return last === null || last === first ? null : last;
}

/** Whether a note's wall-clock day falls in the window. */
export function inWindow(day: string, window: Pick<MeetingWindow, 'fromDay' | 'toDay'>): boolean {
  return day >= window.fromDay && day <= window.toDay;
}
