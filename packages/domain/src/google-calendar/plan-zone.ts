/**
 * The plan zone (ADR-0046, #587): the zone the primary calendar keeps time
 * in, which event notes and blocks are written on. A sync learns it from
 * Google and the vault's settings keep it, so what reads event notes later —
 * a meeting's start from the calendar, the morning brief, Today's meetings —
 * reads them on the clock they were written on, wherever the Mac is.
 */

import { wallClockIn, type WallTime } from '../meetings/mapping/meeting-when.ts';
import type { LocalTime } from '../automations/schedule.ts';
import { dayHeading } from '../calendar/calendar-range.ts';
import { parseMeetingSetting, PRIMARY_CALENDAR } from './meeting-setting.ts';

/** The vault setting that keeps the plan zone, as an IANA name: `America/Chicago`. */
export const PLAN_ZONE_KEY = 'google_plan_zone';

/** Which sync learned a zone: the meetings sync owns the setting whenever the vault reads meetings. */
export type PlanZoneSource = 'meetings' | 'blocks';

/*
 * Each zone's clock and own name, worked out once: a clock is costly to
 * make, and a brief's schedule or a page drawn each minute reads the same
 * few zones over and over. A zone's rules do not change while the app runs.
 */
const zoneClocks = new Map<string, (instant: number) => WallTime>();
const zoneNames = new Map<string, string | null>();

/** A clock in `timeZone`, made once; refuses a name that is not a zone, as `wallClockIn` does. */
function clockIn(timeZone: string): (instant: number) => WallTime {
  const made = zoneClocks.get(timeZone) ?? wallClockIn(timeZone);
  zoneClocks.set(timeZone, made);
  return made;
}

/** `name` as the zone's own name (`america/chicago` is `America/Chicago`); null when no clock knows it. */
function canonicalZone(name: unknown): string | null {
  if (typeof name !== 'string' || name.trim() === '') return null;
  const typed = name.trim();
  const known = zoneNames.get(typed);
  if (known !== undefined) return known;
  const zone = ownName(typed);
  zoneNames.set(typed, zone);
  return zone;
}

function ownName(timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch (cause) {
    // A name no clock knows is refused so; anything else is not the name's fault.
    if (cause instanceof RangeError) return null;
    throw cause;
  }
}

/**
 * The plan zone the vault's settings keep, by the zone's own name, so a
 * zone typed by hand as `america/chicago` is the one Google names
 * `America/Chicago`; null when they keep none, or one no clock knows.
 */
export function storedPlanZone(settings: Readonly<Record<string, unknown>>): string | null {
  return canonicalZone(settings[PLAN_ZONE_KEY]);
}

/** Whether two zones are one, however each was written. */
export function sameZone(one: string | null, other: string | null): boolean {
  return canonicalZone(one) === canonicalZone(other);
}

/**
 * The zone a meetings sync's calendars name, as `planZone` picks it — the
 * primary calendar's, else the first that names one — or null when none
 * did. The Mac's own is never learned: kept, it would move every reader
 * onto the clock of wherever the Mac happened to be.
 */
export function namedPlanZone(calendarZones: Readonly<Record<string, string>>): string | null {
  return calendarZones[PRIMARY_CALENDAR] ?? Object.values(calendarZones)[0] ?? null;
}

/** The calendar whose zone is the plan zone: the primary when it is read, else the first read. */
export function namingCalendar(calendars: readonly string[]): string | null {
  return calendars.includes(PRIMARY_CALENDAR) ? PRIMARY_CALENDAR : (calendars[0] ?? null);
}

/** The zones one meetings sync plans its notes on, and the zone it learned to keep. */
export interface SyncZones {
  /** As `EventNotesInput.calendarZones` takes them: `planZone` of these is the clock notes are written on. */
  readonly calendarZones: Readonly<Record<string, string>>;
  /** The zone to keep; null when this sync learned none it may keep. */
  readonly learned: string | null;
}

/**
 * What one meetings sync plans on and keeps (#587, ADR-0046). When the
 * calendar that names the plan zone (`namingCalendar`) failed this time, the
 * others' zones say nothing of it: a team calendar on London's clock would
 * move every reader of the primary's Chicago notes onto London's. So the
 * sync learns nothing, and plans this time's notes on the zone kept, as the
 * notes already written are. With none kept yet, it plans as the calendars
 * it read say, and keeps nothing until the naming calendar answers.
 */
export function syncZones({
  calendars,
  listedZones,
  failed,
  stored,
}: {
  /** The calendars the sync reads meetings from, in order. */
  calendars: readonly string[];
  /** The zone each calendar that answered keeps. */
  listedZones: Readonly<Record<string, string>>;
  /** The calendars that did not answer this time. */
  failed: readonly string[];
  stored: string | null;
}): SyncZones {
  const namer = namingCalendar(calendars);
  if (namer === null || !failed.includes(namer)) {
    return { calendarZones: listedZones, learned: namedPlanZone(listedZones) };
  }
  // The kept zone stands in for the naming calendar's, first, so `namedPlanZone` picks it.
  const calendarZones = stored === null ? listedZones : { [namer]: stored, ...listedZones };
  return { calendarZones, learned: null };
}

/**
 * Whether the zone the event notes are on has moved (#587): a zone was kept,
 * and the one learned now is another. The notes in the meetings window are
 * then written again on the new one. None kept is no move: every note was
 * written on the zone the calendars named before one was kept, too.
 */
export function planZoneMoved(stored: string | null, learned: string | null): boolean {
  return stored !== null && learned !== null && !sameZone(stored, learned);
}

/**
 * The settings change that keeps a zone a sync learned: nothing when it
 * learned none, when the settings keep it already — however it was typed
 * there — or when a blocks sync learned it in a vault that reads meetings:
 * the meetings sync writes the event notes and so says which clock they are
 * on, and two writers of one setting that can disagree (meetings read from a
 * team calendar only) would rewrite it on every sync.
 */
export function planZoneChange({
  settings,
  learned,
  from,
}: {
  settings: Readonly<Record<string, unknown>>;
  learned: string | null;
  from: PlanZoneSource;
}): Readonly<Record<string, unknown>> {
  const zone = canonicalZone(learned);
  if (zone === null) return {};
  if (from === 'blocks' && parseMeetingSetting(settings).enabled) return {};
  return storedPlanZone(settings) === zone ? {} : { [PLAN_ZONE_KEY]: zone };
}

/** The zone event notes are read on: the one kept, else the Mac's, the nearest one known. */
export function planZoneOr(stored: string | null, timeZone: string): string {
  return stored ?? timeZone;
}

/** What a clock in `timeZone` reads at `instant`, as a schedule keeps time: `2026-10-26T07:00:00`. */
export function wallTimeIn(timeZone: string, instant: number): LocalTime {
  const { day, time } = clockIn(timeZone)(instant);
  return `${day}T${time}`;
}

/** The day a clock in `timeZone` reads at `instant`, `YYYY-MM-DD`. */
export function wallDayIn(timeZone: string, instant: number): string {
  return clockIn(timeZone)(instant).day;
}

/** A zone as a person names it: `America/Los_Angeles` is `Los Angeles`. */
export function zonePlaceName(timeZone: string): string {
  return (timeZone.split('/').at(-1) ?? timeZone).replaceAll('_', ' ');
}

/**
 * What says a time is on the calendar's clock, not the Mac's (#587):
 * `Chicago time`. Null when no zone is kept, or the Mac keeps the same one,
 * since a time on the Mac's own clock needs no word.
 */
export function planClockLabel({
  planZone,
  macZone,
}: {
  planZone: string | null;
  macZone: string;
}): string | null {
  const zone = canonicalZone(planZone);
  if (zone === null || sameZone(zone, macZone)) return null;
  return `${zonePlaceName(zone)} time`;
}

/**
 * Today's meetings' heading (#587): `Meetings`, or, when they are the
 * calendar's day on another clock than the Mac's, which day and clock —
 * `Meetings · Tue 27 Oct, Chicago time`.
 */
export function meetingsHeading({
  day,
  planZone,
  macZone,
}: {
  day: string;
  planZone: string | null;
  macZone: string;
}): string {
  const clock = planClockLabel({ planZone, macZone });
  if (clock === null) return 'Meetings';
  const { weekday, day: date, month } = dayHeading(day);
  return `Meetings · ${weekday} ${date} ${month}, ${clock}`;
}
