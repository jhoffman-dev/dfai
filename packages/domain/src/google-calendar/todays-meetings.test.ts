import { describe, expect, it } from 'vitest';
import { dayMeetings, parseMeetingSetting, type DayEventRow } from './index.ts';

const rows = (path: string, values: Record<string, string | string[]>): DayEventRow[] =>
  Object.entries(values).flatMap(([key, value]) =>
    (Array.isArray(value) ? value : [value]).map((item) => ({
      path,
      title: path.replace(/^.*\//, '').replace(/\.md$/, ''),
      key,
      value: item,
    })),
  );

const DAY = '2026-10-24';

describe('dayMeetings', () => {
  it('lists the day’s timed meetings earliest first, with whom and what they link', () => {
    const meetings = dayMeetings(
      [
        ...rows('Calendar/Review.md', { date: `${DAY}T14:00`, ends: `${DAY}T15:00` }),
        ...rows('Calendar/Standup.md', {
          date: `${DAY}T09:00`,
          ends: `${DAY}T09:15`,
          gcal_response: 'accepted',
          people: ['People/Mara Quill.md', 'People/Tobias Fenn.md'],
          companies: 'Companies/Larkspur Payroll.md',
          meeting: 'Inbox/Meetings/Standup.md',
        }),
      ],
      DAY,
    );
    expect(meetings).toEqual([
      {
        path: 'Calendar/Standup.md',
        title: 'Standup',
        start: '09:00',
        end: '09:15',
        people: ['People/Mara Quill.md', 'People/Tobias Fenn.md'],
        companies: ['Companies/Larkspur Payroll.md'],
        meeting: 'Inbox/Meetings/Standup.md',
        unanswered: false,
      },
      {
        path: 'Calendar/Review.md',
        title: 'Review',
        start: '14:00',
        end: '15:00',
        people: [],
        companies: [],
        meeting: null,
        unanswered: false,
      },
    ]);
  });

  it('leaves out a declined meeting, a cancelled one and an all-day event', () => {
    const meetings = dayMeetings(
      [
        ...rows('Calendar/Declined.md', { date: `${DAY}T10:00`, gcal_response: 'declined' }),
        ...rows('Calendar/Cancelled.md', { date: `${DAY}T11:00`, gcal_missing: 'true' }),
        ...rows('Calendar/Offsite.md', { date: DAY }),
        ...rows('Calendar/Kept.md', { date: `${DAY}T12:00`, gcal_missing: 'false' }),
      ],
      DAY,
    );
    expect(meetings.map((meeting) => meeting.title)).toEqual(['Kept']);
  });

  it('says a meeting not yet answered, or answered maybe, is unanswered', () => {
    const meetings = dayMeetings(
      [
        ...rows('Calendar/Maybe.md', { date: `${DAY}T10:00`, gcal_response: 'tentative' }),
        ...rows('Calendar/Open.md', { date: `${DAY}T11:00`, gcal_response: 'needsAction' }),
      ],
      DAY,
    );
    expect(meetings.map((meeting) => meeting.unanswered)).toEqual([true, true]);
  });

  it('leaves out another day’s meetings, and gives no end for one ending tomorrow', () => {
    const meetings = dayMeetings(
      [
        ...rows('Calendar/Yesterday.md', { date: '2026-10-23T23:00', ends: `${DAY}T01:00` }),
        ...rows('Calendar/Late.md', { date: `${DAY}T23:00`, ends: '2026-10-25T01:00' }),
      ],
      DAY,
    );
    expect(meetings).toMatchObject([{ title: 'Late', start: '23:00', end: null }]);
  });

  it('orders meetings at the same time by title', () => {
    const meetings = dayMeetings(
      [
        ...rows('Calendar/b.md', { date: `${DAY}T09:00` }),
        ...rows('Calendar/a.md', { date: `${DAY}T09:00` }),
      ],
      DAY,
    );
    expect(meetings.map((meeting) => meeting.title)).toEqual(['a', 'b']);
  });
});

describe('parseMeetingSetting', () => {
  it('is off, reading the main calendar, until the vault says otherwise', () => {
    expect(parseMeetingSetting({})).toEqual({ enabled: false, calendars: ['primary'] });
    expect(parseMeetingSetting({ google_meetings: 'yes' }).enabled).toBe(false);
  });

  it('reads the calendars named, each once, in order', () => {
    expect(
      parseMeetingSetting({
        google_meetings: true,
        google_meeting_calendars: [' primary ', 'team@example.com', 'primary', 7, ''],
      }),
    ).toEqual({ enabled: true, calendars: ['primary', 'team@example.com'] });
    expect(parseMeetingSetting({ google_meeting_calendars: 'team@example.com' }).calendars).toEqual(
      ['team@example.com'],
    );
  });
});
