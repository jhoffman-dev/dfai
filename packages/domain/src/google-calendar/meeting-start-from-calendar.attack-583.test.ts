/**
 * Attack on #582 / PR #583: a meeting with no start of its own takes its
 * calendar event's. A seeded property run over random days of events and
 * arrivals against a hand-written oracle, then the edges. All names are made up.
 */
import { describe, expect, it } from 'vitest';
import {
  mapMeeting,
  MeetingMappingError,
  meetingStartAsk,
  type MeetingFields,
} from '../meetings/index.ts';
import {
  calendarStartFor,
  MEETING_NOTES_ARRIVAL_WINDOW_MINUTES,
  type DayEventTimes,
} from './meeting-match.ts';

/** mulberry32, so every run is the same run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = '2026-10-24';
const ZONE = { timeZone: 'UTC' };
const pad = (n: number) => String(n).padStart(2, '0');
const wall = (minutes: number) => `${DAY}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const minutesOf = (wallTime: string) =>
  Number(wallTime.slice(11, 13)) * 60 + Number(wallTime.slice(14, 16));

/** Same title as the meeting, in another spelling the rule treats as one; or another meeting. */
const TITLES = ['Wren standup', 'wren  STANDUP', ' Wren standup ', 'Heron review', 'Wren standup!'];
const SAME = new Set(['Wren standup', 'wren  STANDUP', ' Wren standup ']);

const BASE: MeetingFields = {
  source: 'gemini',
  sourceId: 'attack583',
  title: 'Wren standup',
  stated: 'Notes: “Wren standup” Oct 24, 2026',
  attendees: [{ name: 'Ilsa Fenn', email: 'ilsa.fenn@example.com' }],
  sections: '## Summary\n\nNothing decided.',
};

const TIMED_TRANSCRIPT = [
  '### 00:00:12',
  'Ilsa Fenn: Morning.',
  '### Transcription ended after 00:11:49',
].join('\n');

function randomDay(random: () => number): DayEventTimes[] {
  const count = Math.floor(random() * 5);
  return Array.from({ length: count }, () => {
    const start = Math.floor(random() * 22 * 60);
    const length = 15 + Math.floor(random() * 90);
    const end = Math.min(start + length, 23 * 60 + 59);
    return {
      title: TITLES[Math.floor(random() * TITLES.length)] ?? 'Wren standup',
      start: wall(start),
      end: random() < 0.1 ? null : wall(end),
    };
  });
}

/** The rule as the PR states it, written independently. */
function oracle(events: readonly DayEventTimes[], arrived: string): DayEventTimes[] {
  const at = minutesOf(arrived);
  return events.filter((event) => {
    if (!SAME.has(event.title) || event.end === null) return false;
    const since = at - minutesOf(event.end);
    return since >= 0 && since <= MEETING_NOTES_ARRIVAL_WINDOW_MINUTES;
  });
}

const frontmatterOf = (content: string) => content.split('\n---\n')[0] ?? '';

describe('calendar start, seeded property (500 days)', () => {
  it('takes a calendar start only for exactly one fitting event, always that event’s start, else refuses as invalid', () => {
    const random = seeded(583);
    for (let run = 0; run < 500; run += 1) {
      const events = randomDay(random);
      const arrivedAt = Math.floor(random() * 24 * 60);
      const arrived = wall(arrivedAt);
      const withTranscript = random() < 0.5;
      const fields: MeetingFields = {
        ...BASE,
        arrived: `${arrived}:00Z`,
        ...(withTranscript ? { transcript: TIMED_TRANSCRIPT } : {}),
      };
      const ask = meetingStartAsk(fields, ZONE);
      expect(ask).toEqual({
        title: 'Wren standup',
        day: DAY,
        arrived,
        arrivedAt: Date.parse(`${arrived}:00Z`),
        timeZone: 'UTC',
        dayBefore: false,
      });
      if (ask === null) continue;
      const calendar = calendarStartFor(ask, events);
      const fits = oracle(events, arrived);
      const only = fits[0];
      if (fits.length === 1 && only !== undefined) {
        expect(calendar).toEqual({
          found: true,
          day: DAY,
          start: only.start.slice(11),
          end: only.end?.slice(11) ?? null,
        });
        const front = frontmatterOf(mapMeeting(fields, { ...ZONE, calendar }).content);
        expect(front).toContain(`start: '${only.start.slice(11)}'`);
        expect(front).toContain('start_source: calendar');
        // An approximate start is never written when an exact calendar start exists.
        expect(front).not.toContain('start_approximate');
        continue;
      }
      expect(calendar.found).toBe(false);
      if (withTranscript) {
        const front = frontmatterOf(mapMeeting(fields, { ...ZONE, calendar }).content);
        expect(front).toContain('start_approximate: true');
        expect(front).not.toContain('start_source');
      } else {
        expect(() => mapMeeting(fields, { ...ZONE, calendar })).toThrow(MeetingMappingError);
      }
    }
  });

  it('lets a start the meeting carries (start, subject time, date time, first word) win over any calendar', () => {
    const random = seeded(584);
    const calendar = { found: true, day: DAY, start: '03:03', end: '03:33' } as const;
    const own: MeetingFields[] = [
      { ...BASE, start: '09:30' },
      { ...BASE, stated: 'Notes: “Wren standup” Oct 24, 2026 at 9:30 AM GMT' },
      { ...BASE, stated: undefined, date: `${DAY}T09:30` },
    ];
    for (let run = 0; run < 100; run += 1) {
      const fields = own[Math.floor(random() * own.length)] ?? BASE;
      const withArrival = { ...fields, arrived: `${DAY}T${pad(10 + (run % 10))}:00:00Z` };
      expect(meetingStartAsk(withArrival, ZONE)).toBeNull();
      const front = frontmatterOf(mapMeeting(withArrival, { ...ZONE, calendar }).content);
      expect(front).toContain("start: '09:30'");
      expect(front).not.toContain('start_source');
    }
  });
});

describe('calendar start, edges', () => {
  const ask = (arrived: string, title = 'Wren standup') => ({ title, day: DAY, arrived });
  const STANDUP: DayEventTimes = { title: 'Wren standup', start: wall(600), end: wall(615) };

  it('takes an event the notes arrived exactly at the end of, and exactly 180 minutes after', () => {
    expect(calendarStartFor(ask(wall(615)), [STANDUP])).toMatchObject({ found: true });
    expect(calendarStartFor(ask(wall(615 + 180)), [STANDUP])).toMatchObject({ found: true });
    expect(calendarStartFor(ask(wall(615 + 181)), [STANDUP])).toMatchObject({ found: false });
  });

  it('never takes an event still running when the notes arrived', () => {
    expect(calendarStartFor(ask(wall(614)), [STANDUP])).toMatchObject({ found: false });
  });

  it('takes the afternoon standup, not the morning one, for notes arriving after the afternoon one', () => {
    const morning = { title: 'Wren standup', start: wall(540), end: wall(555) };
    const afternoon = { title: 'Wren standup', start: wall(900), end: wall(915) };
    // Arrival 15:30: the morning one ended 6h15 before, outside the window.
    expect(calendarStartFor(ask(wall(930)), [morning, afternoon])).toEqual({
      found: true,
      day: DAY,
      start: '15:00',
      end: '15:15',
    });
  });

  it('refuses a meeting with a blank title rather than matching an untitled event', () => {
    const untitled = { title: '   ', start: wall(600), end: wall(615) };
    expect(calendarStartFor(ask(wall(620), '  '), [untitled])).toMatchObject({ found: false });
  });

  it('matches a title written decomposed (NFD) to the composed one', () => {
    const cafe = { title: 'Café review', start: wall(600), end: wall(615) };
    expect(calendarStartFor(ask(wall(620), 'Café REVIEW'), [cafe])).toMatchObject({
      found: true,
    });
  });

  // Gmail subjects in Hebrew or Arabic often carry an invisible right-to-left
  // mark; the rule drops the zero-width space but not U+200E/U+200F.
  it('matches a title carrying an invisible right-to-left mark to the same title without one', () => {
    expect(calendarStartFor(ask(wall(620), 'Wren standup‏'), [STANDUP])).toMatchObject({
      found: true,
    });
  });

  // On 2026-11-01 Los Angeles falls back at 02:00 PDT to 01:00 PST. The event
  // ran 00:30–01:30 PDT (07:30–08:30Z); the notes arrived 01:15 PST (09:15Z),
  // 45 real minutes after it ended. On the wall clock the arrival reads as
  // before the end, so the event is taken as still running.
  it('takes an event that ended 45 real minutes before the notes on the fall-back day', () => {
    const fields: MeetingFields = {
      ...BASE,
      stated: 'Notes: “Wren standup” Nov 1, 2026',
      arrived: '2026-11-01T09:15:00Z',
    };
    const zone = { timeZone: 'America/Los_Angeles' };
    const found = meetingStartAsk(fields, zone);
    expect(found).not.toBeNull();
    if (found === null) return;
    const event = { title: 'Wren standup', start: '2026-11-01T00:30', end: '2026-11-01T01:30' };
    expect(calendarStartFor(found, [event])).toMatchObject({ found: true, start: '00:30' });
  });

  // `end` the sender gives wins over the event's, but nothing checks it
  // against the start that came off the calendar: the file says 10:00–09:00.
  it('never writes an end before a calendar start', () => {
    const fields: MeetingFields = { ...BASE, arrived: `${wall(640)}:00Z`, end: '09:00' };
    const calendar = calendarStartFor(ask(wall(640)), [
      { title: 'Wren standup', start: wall(600), end: wall(630) },
    ]);
    let front: string;
    try {
      front = frontmatterOf(mapMeeting(fields, { ...ZONE, calendar }).content);
    } catch (error) {
      expect(error).toBeInstanceOf(MeetingMappingError);
      return;
    }
    expect(front).toContain("start: '10:00'");
    expect(front).not.toContain("end: '09:00'");
  });
});
