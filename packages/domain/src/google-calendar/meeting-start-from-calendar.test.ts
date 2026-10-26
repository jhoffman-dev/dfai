/**
 * A meeting sent with a day but no time and no transcript length (a Gemini
 * notes email, `Oct 24, 2026`) takes its start and end from the calendar
 * event it was: the one on that day, under its title, that ended at or
 * before the notes arrived and within the window before it. Two such events,
 * or none, and it is refused, saying what the sender can add. All names are made up.
 */
import { describe, expect, it } from 'vitest';
import { mapMeeting, meetingStartAsk, type MeetingFields } from '../meetings/index.ts';
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
    expect(meetingStartAsk(SENT, ZONE)).toEqual(MEETING);
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
    expect(meetingStartAsk(TIMED, ZONE)).toEqual(MEETING);
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
      `and DFAI has no calendar events on 2026-10-24; ${SEND}, or connect Google Calendar so DFAI can take the start from the meeting’s event`,
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
