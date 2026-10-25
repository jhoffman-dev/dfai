import { describe, expect, it } from 'vitest';
import { planEventNotes, meetingWindow, createVaultPath, type MeetingWindow } from '@dfai/domain';
import { eventsPage } from './events-list.ts';

/*
 * Attack on PR #573 (#31, ADR-0046): "A confirmed event whose time cannot be
 * read is left alone, never taken for gone." The reader drops such an event
 * before the plan sees it, so a full listing marks its note missing.
 */

const ZONE = 'America/Los_Angeles';
const WINDOW = meetingWindow({ today: '2026-10-24', timeZone: ZONE }) as MeetingWindow;

const unreadable = {
  id: 'ev-standup',
  status: 'confirmed',
  summary: 'Payroll standup',
  // No offset: not RFC 3339, so the instant cannot be read.
  start: { dateTime: '2026-10-24T09:00:00' },
  end: { dateTime: '2026-10-24T09:30:00' },
};

describe('attack #573: a confirmed event whose start cannot be read', () => {
  it('is kept in the page, so the plan can leave its note alone', () => {
    const page = eventsPage({ items: [unreadable] }, 'primary');
    expect(page?.events.map(({ id }) => id)).toEqual(['ev-standup']);
  });

  it('is never marked missing by a full listing', () => {
    const page = eventsPage({ items: [unreadable] }, 'primary');
    const writes = planEventNotes({
      events: page?.events ?? [],
      existing: [
        {
          path: createVaultPath('Calendar/2026-10-24 Payroll standup.md'),
          properties: {
            type: 'event',
            title: 'Payroll standup',
            date: '2026-10-24T09:00',
            gcal_event_id: 'ev-standup',
            gcal_calendar: 'primary',
          },
        },
      ],
      complete: ['primary'],
      window: WINDOW,
      timeZone: ZONE,
      ignoredCalendars: [],
      people: [],
      companies: [],
      meetings: [],
      linkTo: (path) => `[[${path}]]`,
      taken: new Set(),
    });
    expect(writes).toEqual([]);
  });

  it('keeps an event a page repeats once, and an attendee with an odd address as given', () => {
    const odd = {
      ...unreadable,
      start: { dateTime: '2026-10-24T09:00:00-07:00' },
      end: { dateTime: '2026-10-24T09:30:00-07:00' },
      attendees: [{ email: '"mara quill"@[127.0.0.1]', responseStatus: 'bogus' }, 'x', null],
    };
    const page = eventsPage({ items: [odd, odd] }, 'primary');
    expect(page?.events[0]?.attendees).toEqual([
      {
        email: '"mara quill"@[127.0.0.1]',
        name: null,
        self: false,
        response: null,
        resource: false,
      },
    ]);
  });
});
