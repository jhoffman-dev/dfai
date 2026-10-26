import { describe, expect, it } from 'vitest';
import { dayEventTimes, dayMeetings, parseMeetingSetting, type DayEventRow } from './index.ts';

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
  it('lists an event once however many notes carry its id, as its first note says', () => {
    const standup = { date: `${DAY}T09:00`, gcal_event_id: 'ev-standup' };
    const meetings = dayMeetings(
      [
        ...rows('Calendar/Standup 2.md', standup),
        ...rows('Calendar/Standup.md', standup),
        ...rows('Calendar/Review.md', { date: `${DAY}T14:00`, gcal_event_id: 'ev-review' }),
      ],
      DAY,
    );
    expect(meetings.map(({ path }) => path)).toEqual(['Calendar/Standup.md', 'Calendar/Review.md']);
  });

  it('takes an event off the day only once every one of its notes is marked cancelled', () => {
    const standup = { date: `${DAY}T09:00`, gcal_event_id: 'ev-standup', gcal_missing: 'true' };
    const meetings = dayMeetings(
      [...rows('Calendar/Standup.md', standup), ...rows('Calendar/Standup 2.md', standup)],
      DAY,
    );
    expect(meetings).toEqual([]);
  });

  it('keeps a meeting live on one calendar though its twin is cancelled on another', () => {
    const standup = { date: `${DAY}T09:00`, gcal_event_id: 'ev-standup' };
    const meetings = dayMeetings(
      [
        ...rows('Calendar/Standup.md', {
          ...standup,
          gcal_calendar: 'team@larkspur.example',
          gcal_missing: 'true',
        }),
        ...rows('Calendar/Standup 2.md', { ...standup, gcal_calendar: 'primary' }),
      ],
      DAY,
    );
    expect(meetings.map(({ path }) => path)).toEqual(['Calendar/Standup 2.md']);
  });

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

describe('dayEventTimes', () => {
  const late = { date: `${DAY}T23:00`, ends: '2026-10-25T00:15', gcal_event_id: 'ev-late' };

  it('gives an event that runs past midnight its end on its own day, where Today shows none', () => {
    const day = rows('Calendar/Late.md', late);
    expect(dayEventTimes(day, DAY).events).toEqual([
      { title: 'Late', start: `${DAY}T23:00`, end: '2026-10-25T00:15' },
    ]);
    expect(dayMeetings(day, DAY)[0]?.end).toBeNull();
  });

  it('lists the events dayMeetings lists, each once, and counts every note the day held', () => {
    const standup = { date: `${DAY}T09:00`, ends: `${DAY}T09:15`, gcal_event_id: 'ev-standup' };
    const day = [
      ...rows('Calendar/Standup.md', standup),
      ...rows('Calendar/Standup 2.md', standup),
      ...rows('Calendar/Declined.md', {
        ...late,
        gcal_event_id: 'ev-d',
        gcal_response: 'declined',
      }),
      ...rows('Calendar/Gone.md', { ...late, gcal_event_id: 'ev-g', gcal_missing: 'true' }),
      ...rows('Calendar/Offsite.md', { date: DAY, gcal_event_id: 'ev-offsite' }),
    ];
    expect(dayEventTimes(day, DAY)).toEqual({
      events: [{ title: 'Standup', start: `${DAY}T09:00`, end: `${DAY}T09:15` }],
      notes: 5,
    });
  });
});
