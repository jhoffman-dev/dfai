import { describe, expect, it } from 'vitest';
import { createSettingsWriter } from '../settings/settings-writer.ts';
import { createVaultPath, type EventAttendee, type GoogleEvent } from '@dfai/domain';
import { automationVault, sqliteIndexPort } from '@dfai/application/testing/sqlite';
import type { IndexPort } from '../index/ports.ts';
import { toIndexedNote } from '../index/to-indexed-note.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { fakeCalendarSource, memoryMeetingSyncRecords } from '../testing/fake-google-calendar.ts';
import { readDayMeetings } from './read-day-meetings.ts';
import { GoogleCalendarError, type CalendarSource } from './ports.ts';
import { syncMeetings, type MeetingSyncRun } from './sync-meetings.ts';

/*
 * Attack on PR #573 (#31, ADR-0046). Each test names one invariant the
 * meetings sync should hold and, at the time of writing, does not.
 */

const VAULT = '/Users/someone/Vault';
const ZONE = 'America/Los_Angeles';
const TODAY = '2026-10-24';
const NOW = Date.parse('2026-10-24T14:00:00Z');
const NOTE = 'Calendar/2026-10-24 Payroll standup.md';

const file = (properties: Record<string, unknown>, body = '') =>
  `---\n${JSON.stringify(properties)}\n---\n${body}`;

const self = (response: EventAttendee['response'] = 'accepted'): EventAttendee => ({
  email: 'james@larkspur.example',
  name: null,
  self: true,
  response,
  resource: false,
});
const mara: EventAttendee = {
  email: 'mara@larkspur.example',
  name: 'Mara Quill',
  self: false,
  response: 'accepted',
  resource: false,
};

/** 09:00–09:30 in Los Angeles on the day given. */
const meeting = (overrides: Partial<GoogleEvent> = {}, day = TODAY): GoogleEvent => ({
  id: 'ev-standup',
  calendarId: 'primary',
  status: 'confirmed',
  title: 'Payroll standup',
  start: { kind: 'timed', at: Date.parse(`${day}T16:00:00Z`) },
  end: { kind: 'timed', at: Date.parse(`${day}T16:30:00Z`) },
  attendees: [self(), mara],
  recurringEventId: null,
  eventType: 'default',
  ...overrides,
});

function liveIndex(
  files: ReadonlyMap<string, string>,
  markdown: MarkdownPort,
): Pick<IndexPort, 'query'> {
  return {
    query: async (sql, parameters) => {
      const index = sqliteIndexPort();
      const notePaths = [...files.keys()].map(createVaultPath);
      await index.put(
        [...files].map(([path, text]) =>
          toIndexedNote({
            file: { path, text, modified: 1, size: text.length },
            notePaths,
            markdown,
          }),
        ),
      );
      return index.query(sql, parameters);
    },
  };
}

function setUp({
  calendars = { primary: [meeting()] },
  notes = {},
}: {
  calendars?: Record<string, GoogleEvent[]>;
  notes?: Record<string, string>;
} = {}) {
  const vault = automationVault({
    today: TODAY,
    notes: {
      'People/Mara Quill.md': file({ type: 'person', email: 'mara@larkspur.example' }),
      ...notes,
    },
  });
  const google = fakeCalendarSource(calendars);
  /** One Mac: its own sync record and zone, the shared vault and Google account. */
  const mac = (timeZone: string, source: CalendarSource = google.source) => {
    const { records, kept } = memoryMeetingSyncRecords();
    const ports = {
      source,
      records,
      fs: vault.ports.fs,
      markdown: vault.ports.markdown,
      index: liveIndex(vault.files, vault.ports.markdown),
      clock: { today: () => TODAY, now: () => NOW },
      settings: createSettingsWriter({ fs: vault.ports.fs, markdown: vault.ports.markdown }),
    };
    const run: MeetingSyncRun = {
      vault: VAULT,
      timeZone,
      setting: { enabled: true, calendars: Object.keys(calendars) },
      blocksCalendarId: null,
    };
    return { ports, kept, sync: () => syncMeetings(ports, run) };
  };
  return { vault, google, mac };
}

const today = (index: Pick<IndexPort, 'query'>) => readDayMeetings({ index, day: TODAY });

describe('attack #573: two notes for one event (a two-Mac race)', () => {
  const twin = 'Calendar/2026-10-24 Payroll standup 2.md';

  it('lists an event on Today once, however many notes carry its id', async () => {
    const { vault, mac } = setUp();
    const one = mac(ZONE);
    await one.sync();
    // The other Mac made its own before git brought this one over.
    vault.files.set(twin, vault.files.get(NOTE) ?? '');
    const meetings = await today(one.ports.index);
    expect(meetings.map(({ path }) => path)).toEqual([NOTE]);
  });

  it('takes a cancelled event off Today, whichever of its notes is marked', async () => {
    const { vault, google, mac } = setUp();
    const one = mac(ZONE);
    await one.sync();
    vault.files.set(twin, vault.files.get(NOTE) ?? '');
    google.change('primary', meeting({ status: 'cancelled', start: null, end: null }));
    await one.sync();
    expect(await today(one.ports.index)).toEqual([]);
  });
});

describe('attack #573: two Macs in different zones', () => {
  it('a second Mac in another zone does not rewrite the times the first wrote', async () => {
    const { vault, mac } = setUp();
    await mac('America/Los_Angeles').sync();
    const written = vault.files.get(NOTE);
    const report = await mac('America/New_York').sync();
    expect(report.updated).toBe(0);
    expect(vault.files.get(NOTE)).toBe(written);
  });
});

describe('attack #573: an invitation on two calendars', () => {
  it('a cancelled copy on a second calendar does not mark a meeting still live on the note’s own calendar', async () => {
    const { vault, google, mac } = setUp({
      calendars: {
        primary: [meeting()],
        'team@example.com': [meeting({ calendarId: 'team@example.com' })],
      },
    });
    const one = mac(ZONE);
    await one.sync();
    expect(vault.properties(NOTE)).toMatchObject({ gcal_calendar: 'primary' });
    // Taken off the team calendar only; still on James's own.
    google.change(
      'team@example.com',
      meeting({ calendarId: 'team@example.com', status: 'cancelled', start: null, end: null }),
    );
    await one.sync();
    expect(vault.properties(NOTE)?.['gcal_missing']).toBeUndefined();
    expect((await today(one.ports.index)).map(({ path }) => path)).toEqual([NOTE]);
  });

  it('a copy changed on a second calendar does not overwrite the answer on the note’s own calendar', async () => {
    const declined = meeting({ attendees: [self('declined'), mara] });
    const { vault, google, mac } = setUp({
      calendars: {
        primary: [declined],
        'team@example.com': [
          meeting({ calendarId: 'team@example.com', attendees: [self('accepted'), mara] }),
        ],
      },
    });
    const one = mac(ZONE);
    await one.sync();
    expect(vault.properties(NOTE)).toMatchObject({ gcal_response: 'declined' });
    google.change(
      'team@example.com',
      meeting({
        calendarId: 'team@example.com',
        title: 'Payroll standup',
        attendees: [self('accepted'), mara],
      }),
    );
    await one.sync();
    expect(vault.properties(NOTE)).toMatchObject({
      gcal_calendar: 'primary',
      gcal_response: 'declined',
    });
  });
});

describe('attack #573: one failing calendar', () => {
  it('a calendar Google refuses (404) does not stop the others from syncing', async () => {
    const { vault, google, mac } = setUp({
      calendars: { 'gone@example.com': [], primary: [meeting()] },
    });
    const refusingOne: CalendarSource = {
      listEvents: async (ask) => {
        if (ask.calendarId === 'gone@example.com') {
          throw new GoogleCalendarError({ kind: 'api_refused', code: '404', message: 'Not Found' });
        }
        return google.source.listEvents(ask);
      },
    };
    const report = await mac(ZONE, refusingOne).sync();
    expect(report.created).toBe(1);
    expect(vault.files.has(NOTE)).toBe(true);
  });
});

describe('attack #573: a note the person edited', () => {
  it('changes only the owned keys, keeping the person’s own key and a CRLF body byte-identical', async () => {
    const { vault, google, mac } = setUp();
    const one = mac(ZONE);
    await one.sync();
    const body = '## Prep\r\n\r\n- ask about the Q4 close\r\n---\r\nnot frontmatter\r\n';
    vault.files.set(NOTE, file({ ...vault.properties(NOTE), mood: 'calm' }, body));
    google.change('primary', meeting({ title: 'Payroll standup (moved)' }));
    await one.sync();
    expect(vault.files.get(NOTE)?.endsWith(body)).toBe(true);
    expect(vault.properties(NOTE)).toMatchObject({ mood: 'calm' });
    expect(vault.properties(NOTE)).toMatchObject({ title: 'Payroll standup (moved)' });
  });
});
