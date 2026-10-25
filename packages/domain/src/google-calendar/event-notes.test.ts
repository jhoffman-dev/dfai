import { describe, expect, it } from 'vitest';
import type { DirectoryCompany, DirectoryPerson } from '../meeting-links/attendee-matching.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import {
  meetingWindow,
  planEventNotes,
  type EventAttendee,
  type EventNotesInput,
  type ExistingEventNote,
  type GoogleEvent,
  type MeetingWindow,
} from './index.ts';

const ZONE = 'America/Los_Angeles';
const WINDOW = meetingWindow({ today: '2026-10-24', timeZone: ZONE }) as MeetingWindow;

const at = (iso: string) => ({ kind: 'timed', at: Date.parse(iso) }) as const;

const self: EventAttendee = {
  email: 'james@larkspur.example',
  name: null,
  self: true,
  response: 'accepted',
  resource: false,
};
const mara: EventAttendee = {
  email: 'mara@larkspur.example',
  name: 'Mara Quill',
  self: false,
  response: 'accepted',
  resource: false,
};
const room: EventAttendee = {
  email: 'room-4@resource.example.com',
  name: 'Room 4',
  self: false,
  response: 'accepted',
  resource: true,
};

/** A 09:00–09:30 meeting in Los Angeles on 2026-10-24. */
const event = (overrides: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id: 'ev-standup',
  calendarId: 'primary',
  status: 'confirmed',
  title: 'Payroll standup',
  start: at('2026-10-24T16:00:00Z'),
  end: at('2026-10-24T16:30:00Z'),
  attendees: [self, mara, room],
  recurringEventId: null,
  eventType: 'default',
  ...overrides,
});

const people: DirectoryPerson[] = [
  {
    path: createVaultPath('People/Mara Quill.md'),
    name: 'Mara Quill',
    emails: ['mara@larkspur.example'],
    aliases: [],
    company: null,
  },
];
const companies: DirectoryCompany[] = [
  {
    path: createVaultPath('Companies/Larkspur Payroll.md'),
    name: 'Larkspur Payroll',
    aliases: [],
    domains: ['larkspur.example'],
  },
];

const linkTo = (path: VaultPath) => `[[${path.replace(/\.md$/, '')}]]`;

const plan = (overrides: Partial<EventNotesInput> = {}) =>
  planEventNotes({
    events: [event()],
    existing: [],
    complete: [],
    window: WINDOW,
    timeZone: ZONE,
    ignoredCalendars: [],
    people,
    companies,
    meetings: [],
    linkTo,
    taken: new Set(),
    ...overrides,
  });

const kept = (path: string, properties: Record<string, unknown>): ExistingEventNote => ({
  path: createVaultPath(path),
  properties,
});

/** The note the first plan makes, as it would read back. */
function madeNote(): ExistingEventNote {
  const [write] = plan();
  if (write?.kind !== 'create') throw new Error('expected a note to be made');
  return { path: write.path, properties: write.properties };
}

describe('planEventNotes: a new meeting', () => {
  it('becomes an event note on the wall clock, its attendees linked to People', () => {
    expect(plan()).toEqual([
      {
        kind: 'create',
        path: 'Calendar/2026-10-24 Payroll standup.md',
        properties: {
          type: 'event',
          title: 'Payroll standup',
          date: '2026-10-24T09:00',
          ends: '2026-10-24T09:30',
          attendees: ['mara@larkspur.example'],
          people: ['[[People/Mara Quill]]'],
          companies: ['[[Companies/Larkspur Payroll]]'],
          gcal_event_id: 'ev-standup',
          gcal_calendar: 'primary',
          gcal_response: 'accepted',
        },
      },
    ]);
  });

  it('takes a free name when the day already has a note of that title', () => {
    const [write] = plan({ taken: new Set(['Calendar/2026-10-24 Payroll standup.md']) });
    expect(write?.path).toBe('Calendar/2026-10-24 Payroll standup 2.md');
  });

  it('names an untitled event as Google does, and a title a link cannot hold safely', () => {
    expect(plan({ events: [event({ title: '  ' })] })[0]).toMatchObject({
      path: 'Calendar/2026-10-24 (No title).md',
      properties: { title: '(No title)' },
    });
    expect(plan({ events: [event({ title: 'Q4 [draft] #plan | ops' })] })[0]?.path).toBe(
      'Calendar/2026-10-24 Q4 draft plan ops.md',
    );
  });

  it('links the meeting note it was written up in', () => {
    const meeting = {
      path: createVaultPath('Inbox/Meetings/Payroll standup.md'),
      title: 'Payroll standup',
      date: '2026-10-24',
      start: '09:02',
    };
    expect(plan({ meetings: [meeting] })[0]).toMatchObject({
      properties: { meeting: '[[Inbox/Meetings/Payroll standup]]' },
    });
  });

  it('leaves an attendee no one in People has unlinked, and never links a room', () => {
    const stranger = { ...mara, email: 'ida@fenn.example', name: 'Ida Brenwick' };
    const [write] = plan({ events: [event({ attendees: [self, stranger, room] })] });
    expect(write).toMatchObject({ properties: { attendees: ['ida@fenn.example'] } });
    expect(write?.kind === 'create' ? write.properties : null).not.toHaveProperty('people');
  });

  it('is made for an event in the window only', () => {
    expect(plan({ events: [event({ start: at('2026-10-22T16:00:00Z'), end: null })] })).toEqual([]);
    expect(plan({ events: [event({ start: at('2026-10-31T16:00:00Z'), end: null })] })).toEqual([]);
    expect(
      plan({ events: [event({ start: at('2026-10-31T06:30:00Z'), end: null })] }),
    ).toHaveLength(1);
  });

  it('is made for an all-day event as its days, and one that began before the window', () => {
    const [offsite] = plan({
      events: [
        event({
          start: { kind: 'day', date: '2026-10-21' },
          end: { kind: 'day', date: '2026-10-25' },
        }),
      ],
    });
    expect(offsite).toMatchObject({ properties: { date: '2026-10-21', ends: '2026-10-24' } });
  });
});

describe('planEventNotes: what is not a meeting note', () => {
  it('writes nothing for a cancelled event that has no note', () => {
    expect(plan({ events: [event({ status: 'cancelled', start: null, end: null })] })).toEqual([]);
  });

  it('writes nothing for focus time, out of office or a working location', () => {
    for (const eventType of ['focusTime', 'outOfOffice', 'workingLocation', 'birthday']) {
      expect(plan({ events: [event({ eventType })] })).toEqual([]);
    }
  });

  it('never reads the blocks calendar, which is DFAI’s own (#30)', () => {
    const block = event({ calendarId: 'dfai-blocks@group.calendar.example.com' });
    expect(plan({ events: [block], ignoredCalendars: [block.calendarId] })).toEqual([]);
  });
});

describe('planEventNotes: a meeting that has a note', () => {
  it('writes nothing when nothing changed', () => {
    expect(plan({ existing: [madeNote()] })).toEqual([]);
  });

  it('writes only what changed when the meeting moves', () => {
    const moved = event({ start: at('2026-10-24T17:00:00Z'), end: at('2026-10-24T17:45:00Z') });
    expect(plan({ events: [moved], existing: [madeNote()] })).toEqual([
      {
        kind: 'update',
        path: 'Calendar/2026-10-24 Payroll standup.md',
        properties: { date: '2026-10-24T10:00', ends: '2026-10-24T10:45' },
      },
    ]);
  });

  it('keeps the people and the meeting the person linked by hand', () => {
    const note = madeNote();
    const linked = kept(note.path, {
      ...note.properties,
      people: ['[[People/Tobias Fenn]]'],
      meeting: '[[Notes/Our own write-up]]',
    });
    expect(plan({ existing: [linked] })).toEqual([
      {
        kind: 'update',
        path: note.path,
        properties: { people: ['[[People/Tobias Fenn]]', '[[People/Mara Quill]]'] },
      },
    ]);
  });

  it('leaves a relation that holds something other than links as it is', () => {
    const note = madeNote();
    const odd = kept(note.path, { ...note.properties, people: { lead: 'Mara' } });
    expect(plan({ existing: [odd] })).toEqual([]);
  });

  it('says when the person declined, and when they answer', () => {
    const declined = event({ attendees: [{ ...self, response: 'declined' }, mara] });
    expect(plan({ events: [declined], existing: [madeNote()] })).toEqual([
      { kind: 'update', path: madeNote().path, properties: { gcal_response: 'declined' } },
    ]);
  });

  it('marks the note missing when Google cancels the event, once, and never removes it', () => {
    const cancelled = event({ status: 'cancelled', start: null, end: null, attendees: [] });
    const note = madeNote();
    expect(plan({ events: [cancelled], existing: [note] })).toEqual([
      { kind: 'missing', path: note.path },
    ]);
    const marked = kept(note.path, { ...note.properties, gcal_missing: true });
    expect(plan({ events: [cancelled], existing: [marked] })).toEqual([]);
  });

  it('leaves the note as it is for a meeting whose time could not be read', () => {
    expect(plan({ events: [event({ start: null, end: null })], existing: [madeNote()] })).toEqual(
      [],
    );
  });

  it('takes the mark off when a cancelled event comes back', () => {
    const note = madeNote();
    const marked = kept(note.path, { ...note.properties, gcal_missing: true });
    expect(plan({ existing: [marked] })).toEqual([
      { kind: 'update', path: note.path, properties: { gcal_missing: null } },
    ]);
  });

  it('follows an event moved out of the window to its new day', () => {
    const later = event({ start: at('2026-11-12T17:00:00Z'), end: at('2026-11-12T17:30:00Z') });
    expect(plan({ events: [later], existing: [madeNote()] })).toEqual([
      {
        kind: 'update',
        path: madeNote().path,
        properties: { date: '2026-11-12T09:00', ends: '2026-11-12T09:30' },
      },
    ]);
  });

  it('writes to the first note by path, by code unit, when a race left two for one event', () => {
    const note = madeNote();
    // ' ' sorts before '.', so the numbered twin is first on every machine.
    const twin = kept('Calendar/2026-10-24 Payroll standup 2.md', note.properties);
    const moved = event({ title: 'Payroll standup (moved)' });
    expect(plan({ events: [moved], existing: [note, twin] })).toEqual([
      { kind: 'update', path: twin.path, properties: { title: 'Payroll standup (moved)' } },
    ]);
  });
});

describe('planEventNotes: recurring and multi-calendar events', () => {
  it('gives each instance of a series its own note, named by its day', () => {
    const monday = event({ id: 'ev-weekly_20261026T160000Z', recurringEventId: 'ev-weekly' });
    const tuesday = event({
      id: 'ev-weekly_20261027T160000Z',
      recurringEventId: 'ev-weekly',
      start: at('2026-10-27T16:00:00Z'),
      end: at('2026-10-27T16:30:00Z'),
    });
    const writes = plan({ events: [monday, tuesday] });
    expect(writes.map((write) => write.path)).toEqual([
      'Calendar/2026-10-24 Payroll standup.md',
      'Calendar/2026-10-27 Payroll standup.md',
    ]);
    expect(writes[1]).toMatchObject({ properties: { gcal_recurring_event_id: 'ev-weekly' } });
  });

  it('marks one cancelled instance of a series and leaves the others', () => {
    const instance = event({ id: 'ev-weekly_20261024T160000Z', recurringEventId: 'ev-weekly' });
    const [write] = plan({ events: [instance] });
    if (write?.kind !== 'create') throw new Error('expected a note');
    const note = kept(write.path, write.properties);
    const other = kept('Calendar/2026-10-27 Payroll standup.md', {
      ...write.properties,
      gcal_event_id: 'ev-weekly_20261027T160000Z',
    });
    const cancelled = { ...instance, status: 'cancelled' as const, start: null, end: null };
    expect(plan({ events: [cancelled], existing: [note, other] })).toEqual([
      { kind: 'missing', path: note.path },
    ]);
  });

  it('writes an invitation on two calendars once, the first calendar’s copy', () => {
    const team = event({ calendarId: 'team@group.calendar.example.com', title: 'Team copy' });
    const writes = plan({ events: [event(), team] });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ properties: { gcal_calendar: 'primary' } });
  });

  it('keeps an invitation cancelled on one calendar but not on the other', () => {
    const gone = event({ status: 'cancelled', start: null, end: null });
    const team = event({ calendarId: 'team@group.calendar.example.com' });
    expect(plan({ events: [gone, team] })).toMatchObject([
      { kind: 'create', properties: { gcal_calendar: 'team@group.calendar.example.com' } },
    ]);
  });
});

describe('planEventNotes: a full listing', () => {
  const lost = () =>
    kept('Calendar/2026-10-25 Vendor review.md', {
      type: 'event',
      title: 'Vendor review',
      date: '2026-10-25T13:00',
      gcal_event_id: 'ev-gone',
      gcal_calendar: 'primary',
    });

  it('marks a note in the window whose event the calendar no longer lists', () => {
    expect(plan({ events: [], existing: [lost()], complete: ['primary'] })).toEqual([
      { kind: 'missing', path: 'Calendar/2026-10-25 Vendor review.md' },
    ]);
  });

  it('leaves it when only the changes were listed, or another calendar was listed in full', () => {
    expect(plan({ events: [], existing: [lost()], complete: [] })).toEqual([]);
    expect(plan({ events: [], existing: [lost()], complete: ['team@example.com'] })).toEqual([]);
  });

  it('leaves a note outside the window, which a listing of the window cannot speak for', () => {
    const old = kept('Calendar/2026-09-01 Kickoff.md', {
      date: '2026-09-01T10:00',
      gcal_event_id: 'ev-old',
      gcal_calendar: 'primary',
    });
    expect(plan({ events: [], existing: [old], complete: ['primary'] })).toEqual([]);
  });
});
