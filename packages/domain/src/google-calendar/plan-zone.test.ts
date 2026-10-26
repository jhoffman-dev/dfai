/** The plan zone (#587): what a sync keeps of it, when it writes, and the clock it gives. */
import { describe, expect, it } from 'vitest';
import { planZone } from './event-notes.ts';
import {
  namedPlanZone,
  planZoneChange,
  planZoneOr,
  storedPlanZone,
  wallDayIn,
  wallTimeIn,
  PLAN_ZONE_KEY,
} from './plan-zone.ts';

const CHICAGO = 'America/Chicago';
const LOS_ANGELES = 'America/Los_Angeles';

describe('storedPlanZone', () => {
  it('reads the zone the settings keep, trimmed', () => {
    expect(storedPlanZone({ [PLAN_ZONE_KEY]: ' America/Chicago ' })).toBe(CHICAGO);
  });

  it('reads none from settings that keep none, or one that is not a zone', () => {
    expect(storedPlanZone({})).toBeNull();
    expect(storedPlanZone({ [PLAN_ZONE_KEY]: '' })).toBeNull();
    expect(storedPlanZone({ [PLAN_ZONE_KEY]: 'Mars/Olympus_Mons' })).toBeNull();
    expect(storedPlanZone({ [PLAN_ZONE_KEY]: 7 })).toBeNull();
  });
});

describe('namedPlanZone', () => {
  it('takes the primary calendar’s zone over any other', () => {
    expect(namedPlanZone({ team: 'Europe/Berlin', primary: CHICAGO })).toBe(CHICAGO);
  });

  it('takes the first calendar that names one when the primary was not read', () => {
    expect(namedPlanZone({ team: 'Europe/Berlin' })).toBe('Europe/Berlin');
  });

  it('learns nothing when no calendar named a zone: the Mac’s is never kept', () => {
    expect(namedPlanZone({})).toBeNull();
  });

  it('is the zone event notes are written on whenever Google names one', () => {
    const zones = { team: 'Europe/Berlin', primary: CHICAGO };
    expect(planZone({ calendarZones: zones, timeZone: LOS_ANGELES })).toBe(namedPlanZone(zones));
    expect(planZone({ calendarZones: {}, timeZone: LOS_ANGELES })).toBe(LOS_ANGELES);
  });
});

describe('planZoneChange', () => {
  const meetingsOn = { google_meetings: true };

  it('keeps a zone the meetings sync learned', () => {
    expect(planZoneChange({ settings: {}, learned: CHICAGO, from: 'meetings' })).toEqual({
      [PLAN_ZONE_KEY]: CHICAGO,
    });
  });

  it('writes nothing when the settings keep that zone already, so a sync never churns the file', () => {
    const settings = { [PLAN_ZONE_KEY]: CHICAGO };
    expect(planZoneChange({ settings, learned: CHICAGO, from: 'meetings' })).toEqual({});
  });

  it('replaces a zone the calendar has moved from', () => {
    const settings = { [PLAN_ZONE_KEY]: LOS_ANGELES };
    expect(planZoneChange({ settings, learned: CHICAGO, from: 'meetings' })).toEqual({
      [PLAN_ZONE_KEY]: CHICAGO,
    });
  });

  it('writes nothing when nothing was learned, or what was is not a zone', () => {
    expect(planZoneChange({ settings: {}, learned: null, from: 'meetings' })).toEqual({});
    expect(planZoneChange({ settings: {}, learned: 'Nowhere/At_All', from: 'blocks' })).toEqual({});
  });

  it('lets a blocks sync keep the zone only in a vault that does not read meetings', () => {
    expect(planZoneChange({ settings: {}, learned: CHICAGO, from: 'blocks' })).toEqual({
      [PLAN_ZONE_KEY]: CHICAGO,
    });
    expect(planZoneChange({ settings: meetingsOn, learned: CHICAGO, from: 'blocks' })).toEqual({});
  });
});

describe('the plan zone’s clock', () => {
  it('reads the kept zone, else the Mac’s', () => {
    expect(planZoneOr(CHICAGO, LOS_ANGELES)).toBe(CHICAGO);
    expect(planZoneOr(null, LOS_ANGELES)).toBe(LOS_ANGELES);
  });

  it('reads an instant on that zone’s wall clock, to the second', () => {
    const instant = Date.parse('2026-10-26T12:00:05Z');
    expect(wallTimeIn(CHICAGO, instant)).toBe('2026-10-26T07:00:05');
    expect(wallTimeIn(LOS_ANGELES, instant)).toBe('2026-10-26T05:00:05');
  });

  it('gives the zone’s own day where the Mac’s is already the next', () => {
    const instant = Date.parse('2026-10-27T03:30:00Z');
    expect(wallDayIn(CHICAGO, instant)).toBe('2026-10-26');
    expect(wallDayIn('Asia/Tokyo', instant)).toBe('2026-10-27');
  });

  it('reads midnight as 00, not 24', () => {
    expect(wallTimeIn(CHICAGO, Date.parse('2026-10-27T05:00:00Z'))).toBe('2026-10-27T00:00:00');
  });
});
