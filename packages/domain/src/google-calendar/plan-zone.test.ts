/** The plan zone (#587): what a sync keeps of it, when it writes, and the clock it gives. */
import { describe, expect, it } from 'vitest';
import { planZone } from './event-notes.ts';
import {
  meetingsHeading,
  namedPlanZone,
  namingCalendar,
  planClockLabel,
  planZoneChange,
  planZoneMoved,
  planZoneOr,
  sameZone,
  storedPlanZone,
  syncZones,
  wallDayIn,
  wallTimeIn,
  zonePlaceName,
  PLAN_ZONE_KEY,
} from './plan-zone.ts';

const CHICAGO = 'America/Chicago';
const LOS_ANGELES = 'America/Los_Angeles';

describe('storedPlanZone', () => {
  it('reads the zone the settings keep, trimmed', () => {
    expect(storedPlanZone({ [PLAN_ZONE_KEY]: ' America/Chicago ' })).toBe(CHICAGO);
  });

  it('reads a zone typed in any case by the zone’s own name', () => {
    expect(storedPlanZone({ [PLAN_ZONE_KEY]: 'america/chicago' })).toBe(CHICAGO);
    expect(storedPlanZone({ [PLAN_ZONE_KEY]: 'utc' })).toBe('UTC');
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

describe('sameZone', () => {
  it('is one zone however each was written', () => {
    expect(sameZone('america/chicago', ' America/Chicago ')).toBe(true);
    expect(sameZone(CHICAGO, LOS_ANGELES)).toBe(false);
    expect(sameZone(null, null)).toBe(true);
    expect(sameZone(CHICAGO, null)).toBe(false);
  });
});

describe('planZoneChange, against a zone typed by hand', () => {
  it('writes nothing over a zone the settings keep in another case or with spaces', () => {
    for (const typed of ['america/chicago', ' America/Chicago ', 'AMERICA/CHICAGO']) {
      expect(
        planZoneChange({
          settings: { [PLAN_ZONE_KEY]: typed },
          learned: CHICAGO,
          from: 'meetings',
        }),
      ).toEqual({});
    }
  });

  it('keeps the zone by its own name when it was learned in another case', () => {
    expect(planZoneChange({ settings: {}, learned: 'america/chicago', from: 'meetings' })).toEqual({
      [PLAN_ZONE_KEY]: CHICAGO,
    });
  });
});

describe('namingCalendar', () => {
  it('is the primary when it is read, else the first calendar read', () => {
    expect(namingCalendar(['team@larkspur.example', 'primary'])).toBe('primary');
    expect(namingCalendar(['team@larkspur.example', 'other@larkspur.example'])).toBe(
      'team@larkspur.example',
    );
    expect(namingCalendar([])).toBeNull();
  });
});

describe('syncZones', () => {
  const TEAM = 'team@larkspur.example';
  const LONDON = 'Europe/London';

  it('plans and keeps as the calendars say when the naming one answered', () => {
    const zones = syncZones({
      calendars: ['primary', TEAM],
      listedZones: { primary: CHICAGO, [TEAM]: LONDON },
      failed: [],
      stored: LOS_ANGELES,
    });
    expect(zones.learned).toBe(CHICAGO);
    expect(planZone({ calendarZones: zones.calendarZones, timeZone: LOS_ANGELES })).toBe(CHICAGO);
  });

  it('learns nothing, and plans on the kept zone, when the primary failed', () => {
    const zones = syncZones({
      calendars: ['primary', TEAM],
      listedZones: { [TEAM]: LONDON },
      failed: ['primary'],
      stored: CHICAGO,
    });
    expect(zones.learned).toBeNull();
    expect(planZone({ calendarZones: zones.calendarZones, timeZone: LOS_ANGELES })).toBe(CHICAGO);
  });

  it('does the same for the first calendar of a vault that reads no primary', () => {
    const zones = syncZones({
      calendars: [TEAM, 'other@larkspur.example'],
      listedZones: { 'other@larkspur.example': LONDON },
      failed: [TEAM],
      stored: CHICAGO,
    });
    expect(zones.learned).toBeNull();
    expect(planZone({ calendarZones: zones.calendarZones, timeZone: LOS_ANGELES })).toBe(CHICAGO);
  });

  it('with no zone kept yet, plans as the others say and keeps nothing', () => {
    const zones = syncZones({
      calendars: ['primary', TEAM],
      listedZones: { [TEAM]: LONDON },
      failed: ['primary'],
      stored: null,
    });
    expect(zones).toEqual({ calendarZones: { [TEAM]: LONDON }, learned: null });
  });

  it('learns from the naming calendar though another failed', () => {
    const zones = syncZones({
      calendars: ['primary', TEAM],
      listedZones: { primary: CHICAGO },
      failed: [TEAM],
      stored: LOS_ANGELES,
    });
    expect(zones.learned).toBe(CHICAGO);
  });
});

describe('planZoneMoved', () => {
  it('is a move only from one kept zone to another', () => {
    expect(planZoneMoved(CHICAGO, 'America/New_York')).toBe(true);
    expect(planZoneMoved('america/chicago', CHICAGO)).toBe(false);
    expect(planZoneMoved(null, CHICAGO)).toBe(false);
    expect(planZoneMoved(CHICAGO, null)).toBe(false);
  });
});

describe('the kept zone over a run of syncs', () => {
  const NEW_YORK = 'America/New_York';
  /** One sync: what it keeps, and whether it lists again, from what it learned. */
  const step = (settings: Record<string, unknown>, learned: string | null) => {
    const stored = storedPlanZone(settings);
    const moved = planZoneMoved(stored, learned);
    return {
      moved,
      settings: { ...settings, ...planZoneChange({ settings, learned, from: 'meetings' }) },
    };
  };

  it('moves between two zones and back, and keeps the last when a sync learns none', () => {
    const learnedRun: (string | null)[] = [
      CHICAGO,
      CHICAGO,
      NEW_YORK,
      NEW_YORK,
      null,
      CHICAGO,
      null,
    ];
    let settings: Record<string, unknown> = {};
    const seen = learnedRun.map((learned) => {
      const next = step(settings, learned);
      settings = next.settings;
      return { kept: storedPlanZone(settings), moved: next.moved };
    });
    expect(seen).toEqual([
      { kept: CHICAGO, moved: false },
      { kept: CHICAGO, moved: false },
      { kept: NEW_YORK, moved: true },
      { kept: NEW_YORK, moved: false },
      { kept: NEW_YORK, moved: false },
      { kept: CHICAGO, moved: true },
      { kept: CHICAGO, moved: false },
    ]);
  });
});

describe('the clock’s words', () => {
  it('names a zone by its place', () => {
    expect(zonePlaceName(LOS_ANGELES)).toBe('Los Angeles');
    expect(zonePlaceName('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(zonePlaceName('UTC')).toBe('UTC');
  });

  it('says whose clock only when it is not the Mac’s', () => {
    expect(planClockLabel({ planZone: CHICAGO, macZone: 'Asia/Tokyo' })).toBe('Chicago time');
    expect(planClockLabel({ planZone: 'america/chicago', macZone: CHICAGO })).toBeNull();
    expect(planClockLabel({ planZone: null, macZone: CHICAGO })).toBeNull();
  });

  it('heads the meetings with their day and clock when that is another’s', () => {
    expect(meetingsHeading({ day: '2026-10-27', planZone: CHICAGO, macZone: 'Asia/Tokyo' })).toBe(
      'Meetings · Tue 27 Oct, Chicago time',
    );
    expect(meetingsHeading({ day: '2026-10-27', planZone: CHICAGO, macZone: CHICAGO })).toBe(
      'Meetings',
    );
    expect(meetingsHeading({ day: '2026-10-27', planZone: null, macZone: CHICAGO })).toBe(
      'Meetings',
    );
  });
});
