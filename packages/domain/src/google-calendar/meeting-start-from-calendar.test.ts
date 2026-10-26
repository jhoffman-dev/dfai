/**
 * A meeting sent with a day but no time and no transcript length (a Gemini
 * notes email, `Oct 24, 2026`) takes its start and end from the calendar
 * event it was: the one on that day, under its title, that ended at or
 * before the notes arrived and within the window before it. Two such events,
 * or none, and it is refused, saying what the sender can add. All names are made up.
 */
import { describe, expect, it } from 'vitest';
import { mapMeeting, meetingStartAsk, type MeetingFields } from '../meetings/index.ts';
import { instantOnClock } from '../meetings/mapping/meeting-when.ts';
import {
  calendarStartFor,
  MEETING_NOTES_ARRIVAL_WINDOW_MINUTES,
  type DayEventTimes,
} from './meeting-match.ts';

const ZONE = { timeZone: 'America/Los_Angeles' };

/** The payload from the report: a stated day, no time, no transcript; arrived 10:40 local. */
const SENT: MeetingFields = {
  source: 'gemini',
  sourceId: '19a2b3c4d5e6f799',
  title: 'Larkspur Payroll onboarding sync',
  stated: 'Notes: “Larkspur Payroll onboarding sync” Oct 24, 2026',
  arrived: '2026-10-24T17:40:00Z',
  attendees: [{ name: 'Mara Quill', email: 'mara.quill@example.com' }],
  sections: '## Summary\n\nThe go-live moves a week.',
};

const SYNC: DayEventTimes = {
  title: 'Larkspur Payroll onboarding sync',
  start: '2026-10-24T10:00',
  end: '2026-10-24T10:30',
};

const MEETING = {
  title: 'Larkspur Payroll onboarding sync',
  day: '2026-10-24',
  arrived: '2026-10-24T10:40',
};

/** MEETING as meetingStartAsk gives it: with the arrival's instant and the clock it is shown on. */
const ASKED = {
  ...MEETING,
  arrivedAt: Date.parse('2026-10-24T17:40:00Z'),
  timeZone: 'America/Los_Angeles',
  dayBefore: false,
};

/** A Gemini transcript with its length: it ended 11:49 in, so less the arrival it would start 10:28, approximate. */
const TIMED = {
  ...SENT,
  transcript: [
    '### 00:00:12',
    'Mara Quill: Morning.',
    '### Transcription ended after 00:11:49',
  ].join('\n'),
};

const frontmatterOf = (content: string) => content.split('\n---\n')[0] ?? '';

function mappedWith(events: readonly DayEventTimes[], fields: MeetingFields = SENT) {
  const ask = meetingStartAsk(fields, ZONE);
  if (ask === null) throw new Error('the meeting should need the calendar');
  return mapMeeting(fields, { ...ZONE, calendar: calendarStartFor(ask, events) });
}

describe('meetingStartAsk', () => {
  it('asks the calendar for the stated day and the local arrival when nothing gives a start', () => {
    expect(meetingStartAsk(SENT, ZONE)).toEqual(ASKED);
  });

  it('asks for the day of `date` when no day is stated, else for the arrival’s', () => {
    const unstated = { ...SENT, stated: undefined };
    expect(meetingStartAsk({ ...unstated, date: '2026-10-23' }, ZONE)?.day).toBe('2026-10-23');
    expect(meetingStartAsk(unstated, ZONE)?.day).toBe('2026-10-24');
  });

  it('asks nothing when the meeting carries its start', () => {
    expect(meetingStartAsk({ ...SENT, start: '10:00' }, ZONE)).toBeNull();
    expect(meetingStartAsk({ ...SENT, stated: `${String(SENT.stated)} 10:00` }, ZONE)).toBeNull();
  });

  it('asks the calendar before the transcript’s length is taken off the arrival', () => {
    expect(meetingStartAsk(TIMED, ZONE)).toEqual(ASKED);
  });
});

describe('a meeting with a day but no time takes its start from the calendar', () => {
  it('takes the start and end of the event that ended ten minutes before the notes arrived', () => {
    const head = frontmatterOf(mappedWith([SYNC]).content);
    expect(head).toContain("date: '2026-10-24'");
    expect(head).toContain("start: '10:00'");
    expect(head).toContain("end: '10:30'");
    expect(head).toContain('start_source: calendar');
    expect(head).not.toContain('start_approximate');
  });

  it('prefers the calendar’s start to the arrival less the transcript’s length', () => {
    expect(frontmatterOf(mapMeeting(TIMED, ZONE).content)).toContain("start: '10:28'");
    const head = frontmatterOf(mappedWith([SYNC], TIMED).content);
    expect(head).toContain("start: '10:00'");
    expect(head).not.toContain('start_approximate');
  });

  it('keeps an end that was sent over the event’s', () => {
    const head = frontmatterOf(mappedWith([SYNC], { ...SENT, end: '10:20' }).content);
    expect(head).toContain("end: '10:20'");
  });

  it('writes no start_source when the start was read from the meeting itself', () => {
    const head = frontmatterOf(mapMeeting({ ...SENT, start: '10:05' }, ZONE).content);
    expect(head).toContain("start: '10:05'");
    expect(head).not.toContain('start_source');
  });
});

describe('a meeting the calendar cannot place is refused, saying what to send', () => {
  const SEND = 'send `start`, a time in the subject, or a transcript with its times';

  it('refuses two events that fit, naming them as a choice it will not make', () => {
    const second = { ...SYNC, start: '2026-10-24T09:00', end: '2026-10-24T09:30' };
    expect(() => mappedWith([SYNC, second])).toThrow(
      'start: the meeting has no start time: the email states none, and with no transcript length the arrival (about when it ended) cannot give one, and 2 events on 2026-10-24 called “Larkspur Payroll onboarding sync” ended in the 3 hours before the notes arrived, so which it was is unclear; ' +
        SEND,
    );
  });

  it('refuses when no event on the day has its title, and says so', () => {
    const other = { ...SYNC, title: 'Vendor review' };
    expect(() => mappedWith([other])).toThrow(
      'and no event on 2026-10-24 called “Larkspur Payroll onboarding sync” ended in the 3 hours before the notes arrived; ' +
        SEND,
    );
  });

  it('asks for the calendar to be connected when DFAI has no events that day', () => {
    expect(() => mappedWith([])).toThrow(
      `and DFAI has no calendar events on 2026-10-24; ${SEND}, or if Google Calendar isn’t connected, connect it so DFAI can take the start from the meeting’s event`,
    );
  });

  it('names what to send when there is no calendar to ask (n8n’s Code nodes)', () => {
    expect(() => mapMeeting(SENT, ZONE)).toThrow(`cannot give one; ${SEND}`);
  });
});

describe('calendarStartFor', () => {
  it('takes the one event under the title that ended at or before the arrival', () => {
    expect(calendarStartFor(MEETING, [SYNC])).toEqual({
      found: true,
      day: '2026-10-24',
      start: '10:00',
      end: '10:30',
    });
  });

  it('takes an event that ended the minute the notes arrived', () => {
    const atArrival = { ...SYNC, end: '2026-10-24T10:40' };
    expect(calendarStartFor(MEETING, [atArrival])).toMatchObject({ found: true });
  });

  it('does not take an event that ends after the notes arrived', () => {
    const running = { ...SYNC, end: '2026-10-24T10:41' };
    expect(calendarStartFor(MEETING, [running])).toMatchObject({ found: false });
  });

  it('does not take an event that gives no end', () => {
    expect(calendarStartFor(MEETING, [{ ...SYNC, end: null }])).toMatchObject({ found: false });
  });

  it(`takes an event that ended ${MEETING_NOTES_ARRIVAL_WINDOW_MINUTES} minutes before, and not one a minute earlier`, () => {
    expect(MEETING_NOTES_ARRIVAL_WINDOW_MINUTES).toBe(180);
    const edge = { ...SYNC, start: '2026-10-24T07:00', end: '2026-10-24T07:40' };
    const before = { ...SYNC, start: '2026-10-24T07:00', end: '2026-10-24T07:39' };
    expect(calendarStartFor(MEETING, [edge])).toMatchObject({ found: true, start: '07:00' });
    expect(calendarStartFor(MEETING, [before])).toMatchObject({ found: false });
  });

  it('takes the one in the window when an earlier event of the title is out of it', () => {
    const morning = { ...SYNC, start: '2026-10-24T06:00', end: '2026-10-24T06:30' };
    expect(calendarStartFor(MEETING, [morning, SYNC])).toMatchObject({
      found: true,
      start: '10:00',
    });
  });

  it('is ambiguous when two events of the title ended in the window', () => {
    const earlier = { ...SYNC, start: '2026-10-24T09:00', end: '2026-10-24T09:30' };
    expect(calendarStartFor(MEETING, [SYNC, earlier])).toMatchObject({ found: false });
  });

  it('does not take an event of another day', () => {
    const yesterday = { ...SYNC, start: '2026-10-23T10:00', end: '2026-10-23T10:30' };
    expect(calendarStartFor(MEETING, [yesterday])).toMatchObject({ found: false });
    expect(
      calendarStartFor({ ...MEETING, day: '2026-10-23', arrived: '2026-10-23T10:40' }, [yesterday]),
    ).toMatchObject({
      found: true,
    });
  });

  it('does not take the day before’s late event, though it ended in the window', () => {
    const lateYesterday = { ...SYNC, start: '2026-10-23T23:00', end: '2026-10-23T23:50' };
    const meeting = { ...MEETING, arrived: '2026-10-24T00:10' };
    expect(calendarStartFor(meeting, [lateYesterday])).toMatchObject({ found: false });
    expect(calendarStartFor({ ...meeting, day: '2026-10-23' }, [lateYesterday])).toMatchObject({
      found: true,
    });
  });

  it('crosses midnight: notes after midnight find the late event of the stated day', () => {
    const late = { ...SYNC, start: '2026-10-24T23:00', end: '2026-10-24T23:50' };
    const meeting = { ...MEETING, arrived: '2026-10-25T00:10' };
    expect(calendarStartFor(meeting, [late])).toMatchObject({ found: true, start: '23:00' });
  });

  it.each([
    ['case', 'larkspur payroll ONBOARDING sync'],
    ['spacing', '  Larkspur   Payroll onboarding sync '],
  ])('matches a title that differs only by %s', (_kind, title) => {
    expect(calendarStartFor(MEETING, [{ ...SYNC, title }])).toMatchObject({ found: true });
  });

  it('matches a title composed another way (é as e and an accent)', () => {
    const cafe = { ...MEETING, title: 'Café review' };
    const event = { ...SYNC, title: 'Café review'.normalize('NFD') };
    expect(event.title).not.toBe(cafe.title);
    expect(calendarStartFor(cafe, [event])).toMatchObject({ found: true });
  });

  it('does not match a title that differs by a word, or a blank one', () => {
    expect(calendarStartFor(MEETING, [{ ...SYNC, title: 'Larkspur Payroll sync' }])).toMatchObject({
      found: false,
    });
    expect(calendarStartFor({ ...MEETING, title: '  ' }, [{ ...SYNC, title: ' ' }])).toMatchObject({
      found: false,
    });
  });
});

describe('the calendar is asked on the clock its event notes are written on', () => {
  // The review's case: the sender says Los Angeles, the event notes are on Chicago's clock.
  const CHICAGO = { timeZone: 'America/Los_Angeles', calendarTimeZone: 'America/Chicago' };
  const notes = { ...SENT, arrived: '2026-10-24T15:05:00Z' };

  it('puts the arrival on the event notes’ clock, not the sender’s', () => {
    expect(meetingStartAsk(notes, CHICAGO)).toMatchObject({
      day: '2026-10-24',
      arrived: '2026-10-24T10:05',
      timeZone: 'America/Chicago',
    });
  });

  // On the sender's clock the notes came at 08:05: the 06:00 one would fit, the 09:30 one not have begun.
  it('takes the event that ended just before the notes on that clock, not one that fits only the sender’s', () => {
    const ask = meetingStartAsk(notes, CHICAGO);
    if (ask === null) throw new Error('the meeting should need the calendar');
    const early = { ...SYNC, start: '2026-10-24T06:00', end: '2026-10-24T06:30' };
    const late = { ...SYNC, start: '2026-10-24T09:30', end: '2026-10-24T10:00' };
    expect(calendarStartFor(ask, [early, late])).toMatchObject({ found: true, start: '09:30' });
  });

  it('puts a local arrival on the sender’s clock first, then on the event notes’', () => {
    const local = { ...SENT, arrived: '2026-10-24T08:05' };
    expect(meetingStartAsk(local, CHICAGO)?.arrived).toBe('2026-10-24T10:05');
  });
});

describe('a meeting that states no day looks at the arrival’s day and the day before', () => {
  const UNSTATED = { ...SENT, stated: undefined, arrived: '2026-10-25T07:10:00Z' };
  const late = { ...SYNC, start: '2026-10-24T22:30', end: '2026-10-24T23:30' };

  it('asks for the day before too, and only then', () => {
    expect(meetingStartAsk(UNSTATED, ZONE)).toMatchObject({ day: '2026-10-25', dayBefore: true });
    expect(meetingStartAsk(SENT, ZONE)).toMatchObject({ dayBefore: false });
    expect(meetingStartAsk({ ...UNSTATED, date: '2026-10-24' }, ZONE)).toMatchObject({
      dayBefore: false,
    });
  });

  it('takes a late-evening event of the day before, and writes the meeting on that day', () => {
    const ask = meetingStartAsk(UNSTATED, ZONE);
    if (ask === null) throw new Error('the meeting should need the calendar');
    const calendar = calendarStartFor(ask, [late]);
    expect(calendar).toEqual({ found: true, day: '2026-10-24', start: '22:30', end: '23:30' });
    const head = frontmatterOf(mapMeeting(UNSTATED, { ...ZONE, calendar }).content);
    expect(head).toContain("date: '2026-10-24'");
    expect(head).toContain("start: '22:30'");
  });

  it('takes neither when both days have one that fits, and names both days', () => {
    const ask = meetingStartAsk({ ...UNSTATED, arrived: '2026-10-25T08:00:00Z' }, ZONE);
    if (ask === null) throw new Error('the meeting should need the calendar');
    const justAfter = { ...SYNC, start: '2026-10-25T00:30', end: '2026-10-25T00:45' };
    expect(calendarStartFor(ask, [late, justAfter])).toEqual({
      found: false,
      why: '2 events on 2026-10-25 or the day before called “Larkspur Payroll onboarding sync” ended in the 3 hours before the notes arrived, so which it was is unclear',
      connect: false,
    });
  });
});

describe('the connect hint, and the end of a calendar start', () => {
  it('suggests connecting only when the days held no event notes at all', () => {
    expect(calendarStartFor(MEETING, [], 0)).toMatchObject({ found: false, connect: true });
    // One declined or cancelled note was left out before matching: a calendar is connected.
    expect(calendarStartFor(MEETING, [], 1)).toEqual({
      found: false,
      why: 'no event on 2026-10-24 called “Larkspur Payroll onboarding sync” ended in the 3 hours before the notes arrived',
      connect: false,
    });
  });

  it('writes no end for an event that ends another day, which HH:MM cannot say', () => {
    const late = { ...SYNC, start: '2026-10-24T23:00', end: '2026-10-25T00:15' };
    const ask = { ...MEETING, arrived: '2026-10-25T00:30' };
    expect(calendarStartFor(ask, [late])).toEqual({
      found: true,
      day: '2026-10-24',
      start: '23:00',
      end: null,
    });
  });

  it('refuses a sent end before the calendar’s start, as invalid input', () => {
    expect(() => mappedWith([SYNC], { ...SENT, end: '09:45' })).toThrow(
      'end: 09:45 is before the start, 10:00; send an end after the start, with its date when the meeting ends the next day',
    );
  });
});

describe('an end before the start', () => {
  it('is refused, whatever gave the start', () => {
    expect(() => mapMeeting({ ...SENT, start: '11:00', end: '10:00' }, ZONE)).toThrow(
      'end: 10:00 is before the start, 11:00',
    );
  });

  it('is kept when it is the start, or sent with the next day’s date', () => {
    const same = frontmatterOf(mapMeeting({ ...SENT, start: '11:00', end: '11:00' }, ZONE).content);
    expect(same).toContain("end: '11:00'");
    const overnight = { ...SENT, start: '23:30', end: '2026-10-25T00:15' };
    expect(frontmatterOf(mapMeeting(overnight, ZONE).content)).toContain("end: '00:15'");
  });
});

describe('an end sent with a start DFAI works out', () => {
  // TIMED's transcript ran 00:11:49, 709 seconds.
  const CHICAGO = { timeZone: 'America/Chicago' };

  it('is never checked against the guess, and the start is the end less the length', () => {
    // Arrival less length would be 10:08, after the end; the review's repro.
    const fields = { ...TIMED, end: '10:00', arrived: '2026-10-24T10:20-05:00' };
    const head = frontmatterOf(mapMeeting(fields, CHICAGO).content);
    expect(head).toContain("start: '09:48'");
    expect(head).toContain("end: '10:00'");
    expect(head).toContain('start_approximate: true');
  });

  it('takes the end less the length when the arrival less the length lands after the end', () => {
    const fields = { ...TIMED, end: '09:00', arrived: '2026-10-24T10:20-05:00' };
    const head = frontmatterOf(mapMeeting(fields, CHICAGO).content);
    expect(head).toContain("start: '08:48'");
    expect(head).toContain("end: '09:00'");
    expect(head).toContain('start_approximate: true');
  });
});

describe('instantOnClock', () => {
  const LA = 'America/Los_Angeles';

  it('reads a wall time on the zone’s clock', () => {
    expect(instantOnClock('2026-10-24T10:40', LA)).toBe(Date.parse('2026-10-24T17:40:00Z'));
  });

  it('takes the earlier of a fall-back hour’s two readings', () => {
    expect(instantOnClock('2026-11-01T01:30', LA)).toBe(Date.parse('2026-11-01T08:30:00Z'));
  });

  it('reads a time the spring change skips as the instant the clocks jump at', () => {
    expect(instantOnClock('2026-03-08T02:30', LA)).toBe(Date.parse('2026-03-08T10:30:00Z'));
  });
});
