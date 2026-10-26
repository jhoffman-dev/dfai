/**
 * The plan zone (ADR-0046, #587): the zone the primary calendar keeps time
 * in, which event notes and blocks are written on. A sync learns it from
 * Google and the vault's settings keep it, so what reads event notes later —
 * a meeting's start from the calendar, the morning brief, Today's meetings —
 * reads them on the clock they were written on, wherever the Mac is.
 */

import { MeetingMappingError } from '../meetings/mapping/meeting-mapping-error.ts';
import { wallClockIn } from '../meetings/mapping/meeting-when.ts';
import type { LocalTime } from '../automations/schedule.ts';
import { parseMeetingSetting, PRIMARY_CALENDAR } from './meeting-setting.ts';

/** The vault setting that keeps the plan zone, as an IANA name: `America/Chicago`. */
export const PLAN_ZONE_KEY = 'google_plan_zone';

/** Which sync learned a zone: the meetings sync owns the setting whenever the vault reads meetings. */
export type PlanZoneSource = 'meetings' | 'blocks';

/** Whether `name` is a zone this Mac's clock can keep. */
function isTimeZone(name: string): boolean {
  try {
    wallClockIn(name);
    return true;
  } catch (cause) {
    if (cause instanceof MeetingMappingError) return false;
    throw cause;
  }
}

/** The plan zone the vault's settings keep; null when they keep none, or one no clock knows. */
export function storedPlanZone(settings: Readonly<Record<string, unknown>>): string | null {
  const value = settings[PLAN_ZONE_KEY];
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name !== '' && isTimeZone(name) ? name : null;
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

/**
 * The settings change that keeps a zone a sync learned: nothing when it
 * learned none, when the settings keep it already, or when a blocks sync
 * learned it in a vault that reads meetings — the meetings sync writes the
 * event notes and so says which clock they are on, and two writers of one
 * setting that can disagree (meetings read from a team calendar only)
 * would rewrite it on every sync.
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
  if (learned === null || !isTimeZone(learned)) return {};
  if (from === 'blocks' && parseMeetingSetting(settings).enabled) return {};
  return settings[PLAN_ZONE_KEY] === learned ? {} : { [PLAN_ZONE_KEY]: learned };
}

/** The zone event notes are read on: the one kept, else the Mac's, the nearest one known. */
export function planZoneOr(stored: string | null, timeZone: string): string {
  return stored ?? timeZone;
}

/** What a clock in `timeZone` reads at `instant`, as a schedule keeps time: `2026-10-26T07:00:00`. */
export function wallTimeIn(timeZone: string, instant: number): LocalTime {
  const { day, time } = wallClockIn(timeZone)(instant);
  return `${day}T${time}`;
}

/** The day a clock in `timeZone` reads at `instant`, `YYYY-MM-DD`. */
export function wallDayIn(timeZone: string, instant: number): string {
  return wallClockIn(timeZone)(instant).day;
}
