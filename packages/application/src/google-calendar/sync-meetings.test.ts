import { describe, expect, it } from 'vitest';
import { createSettingsWriter } from '../settings/settings-writer.ts';
import {
  createVaultPath,
  type EventAttendee,
  type GoogleEvent,
  type MeetingSetting,
} from '@dfai/domain';
import { automationVault, sqliteIndexPort } from '@dfai/application/testing/sqlite';
import type { IndexPort } from '../index/ports.ts';
import { toIndexedNote } from '../index/to-indexed-note.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { fakeCalendarSource, memoryMeetingSyncRecords } from '../testing/fake-google-calendar.ts';
import { readDayMeetings, readTodaysMeetings } from './read-day-meetings.ts';
import { GoogleCalendarError, type CalendarSource } from './ports.ts';
import {
  meetingSyncActivity,
  meetingSyncProblem,
  syncMeetings,
  type MeetingSyncReport,
  type MeetingSyncRun,
} from './sync-meetings.ts';

const VAULT = '/Users/someone/Vault';
const ZONE = 'America/Los_Angeles';
const TODAY = '2026-10-24';
const NOW = Date.parse('2026-10-24T14:00:00Z');

const file = (properties: Record<string, unknown>, body = '') =>
  `---\n${JSON.stringify(properties)}\n---\n${body}`;

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

/** 09:00–09:30 in Los Angeles on the day given. */
const meeting = (overrides: Partial<GoogleEvent> = {}, day = TODAY): GoogleEvent => ({
  id: 'ev-standup',
  calendarId: 'primary',
  status: 'confirmed',
  title: 'Payroll standup',
  start: { kind: 'timed', at: Date.parse(`${day}T16:00:00Z`) },
  end: { kind: 'timed', at: Date.parse(`${day}T16:30:00Z`) },
  attendees: [self, mara],
  recurringEventId: null,
  eventType: 'default',
  ...overrides,
});

/**
 * The vault's index as the app builds it — titles, properties and resolved
 * relations from `toIndexedNote` — rebuilt from the files for every query,
 * so it always holds what is on disk.
 */
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

const PRIMARY: MeetingSetting = { enabled: true, calendars: ['primary'] };

function setUp({
  events = [meeting()],
  today = TODAY,
  notes = {},
  zones = {},
}: {
  events?: GoogleEvent[];
  today?: string;
  notes?: Record<string, string>;
  zones?: Record<string, string | null>;
} = {}) {
  const vault = automationVault({
    today,
    notes: {
      'People/Mara Quill.md': file({ type: 'person', email: 'mara@larkspur.example' }),
      ...notes,
    },
  });
  const google = fakeCalendarSource({ primary: events }, zones);
  const { records, kept } = memoryMeetingSyncRecords();
  let day = today;
  const ports = {
    source: google.source,
    records,
    fs: vault.ports.fs,
    markdown: vault.ports.markdown,
    index: liveIndex(vault.files, vault.ports.markdown),
    clock: { today: () => day, now: () => NOW },
    settings: createSettingsWriter({ fs: vault.ports.fs, markdown: vault.ports.markdown }),
  };
  const run: MeetingSyncRun = {
    vault: VAULT,
    timeZone: ZONE,
    setting: PRIMARY,
    blocksCalendarId: null,
  };
  return {
    vault,
    google,
    kept,
    ports,
    sync: (overrides: Partial<MeetingSyncRun> = {}) =>
      syncMeetings(ports, { ...run, ...overrides }),
    nextDay: (next: string) => {
      day = next;
    },
  };
}

const NOTE = 'Calendar/2026-10-24 Payroll standup.md';

describe('syncMeetings: the first sync', () => {
  it('writes the window’s meetings as event notes, linked to People, and keeps where it left off', async () => {
    const { vault, kept, sync } = setUp();
    const report = await sync();
    expect(report).toEqual({
      ran: NOW,
      created: 1,
      updated: 0,
      missing: 0,
      full: ['primary'],
      problem: null,
      failed: [],
      scopeRefused: false,
      zoneProblem: null,
    });
    expect(vault.properties(NOTE)).toMatchObject({
      type: 'event',
      title: 'Payroll standup',
      date: '2026-10-24T09:00',
      ends: '2026-10-24T09:30',
      attendees: ['mara@larkspur.example'],
      people: ['[[Mara Quill]]'],
      gcal_event_id: 'ev-standup',
      gcal_calendar: 'primary',
    });
    expect(kept.get(VAULT)).toEqual({
      calendars: { primary: { syncToken: 'sync-1', fromDay: '2026-10-23' } },
      lastSyncAt: NOW,
    });
  });

  it('reads them back as today’s meetings, with whom, for the brief', async () => {
    const { ports, sync } = setUp();
    await sync();
    const meetings = await readTodaysMeetings({
      index: ports.index,
      clock: { today: () => TODAY },
    });
    expect(meetings).toEqual([
      {
        path: NOTE,
        title: 'Payroll standup',
        start: '09:00',
        end: '09:30',
        people: ['People/Mara Quill.md'],
        companies: [],
        meeting: null,
        unanswered: false,
      },
    ]);
    expect(await readDayMeetings({ index: ports.index, day: '2026-10-25' })).toEqual([]);
  });

  it('writes nothing, and keeps nothing, for a vault whose calendars are empty', async () => {
    const { vault, sync, kept } = setUp({ events: [] });
    expect(await sync()).toMatchObject({ created: 0, problem: null });
    expect([...vault.files.keys()].some((path) => path.startsWith('Calendar/'))).toBe(false);
    expect(kept.get(VAULT)?.calendars).toEqual({
      primary: { syncToken: 'sync-1', fromDay: '2026-10-23' },
    });
  });
});

describe('syncMeetings: syncs after the first', () => {
  it('asks only what changed, and moves the note, leaving what the person wrote in it', async () => {
    const { vault, google, sync } = setUp();
    await sync();
    vault.files.set(NOTE, `${vault.files.get(NOTE)}Agenda: the Q4 close.\n`);
    google.change(
      'primary',
      meeting({ start: { kind: 'timed', at: Date.parse('2026-10-24T17:00:00Z') } }),
    );
    expect(await sync()).toMatchObject({ updated: 1, full: [] });
    expect(google.state.asked.at(-1)).toEqual({ calendarId: 'primary', syncToken: 'sync-1' });
    expect(vault.properties(NOTE)).toMatchObject({ date: '2026-10-24T10:00' });
    expect(vault.files.get(NOTE)).toContain('Agenda: the Q4 close.');
  });

  it('marks a cancelled meeting missing and keeps the note and its text', async () => {
    const { vault, google, sync } = setUp();
    await sync();
    vault.files.set(NOTE, `${vault.files.get(NOTE)}Prep notes.\n`);
    google.change(
      'primary',
      meeting({ status: 'cancelled', start: null, end: null, attendees: [] }),
    );
    expect(await sync()).toMatchObject({ missing: 1 });
    expect(vault.properties(NOTE)).toMatchObject({ gcal_missing: true, title: 'Payroll standup' });
    expect(vault.files.get(NOTE)).toContain('Prep notes.');
  });

  it('lists the window in full again when Google says the token is no longer valid (410)', async () => {
    const { vault, google, sync } = setUp({
      events: [meeting(), meeting({ id: 'ev-review', title: 'Vendor review' }, '2026-10-26')],
    });
    await sync();
    // Deleted while the token was stale, so no change will ever say so.
    google.state.calendars['primary'] = [meeting()];
    google.expire();
    expect(await sync()).toMatchObject({ missing: 1, full: ['primary'] });
    expect(google.state.asked.slice(-2)).toEqual([
      { calendarId: 'primary', syncToken: 'sync-1' },
      { calendarId: 'primary', syncToken: null },
    ]);
    expect(vault.properties('Calendar/2026-10-26 Vendor review.md')).toMatchObject({
      gcal_missing: true,
    });
  });

  it('lists in full again on a new day, so the week ahead is read as it now stands', async () => {
    const { google, sync, nextDay } = setUp();
    await sync();
    nextDay('2026-10-25');
    expect(await sync()).toMatchObject({ full: ['primary'] });
    expect(google.state.asked.at(-1)?.syncToken).toBeNull();
  });

  it('writes nothing new when nothing changed', async () => {
    const { vault, sync } = setUp();
    await sync();
    const before = vault.log.length;
    expect(await sync()).toMatchObject({ created: 0, updated: 0, missing: 0 });
    expect(vault.log.length).toBe(before);
  });
});

describe('syncMeetings: offline and failing', () => {
  it('reports what went wrong, writes nothing and keeps where the last sync left off', async () => {
    const { vault, google, kept, sync } = setUp();
    await sync();
    google.state.next = new GoogleCalendarError({ kind: 'unreachable', message: 'offline' });
    google.change('primary', meeting({ title: 'Payroll standup (moved)' }));
    const report = await sync();
    expect(report.problem).toEqual({
      problem: 'Google could not be reached: offline.',
      fix: 'Check the connection and try again.',
    });
    expect(vault.properties(NOTE)).toMatchObject({ title: 'Payroll standup' });
    expect(kept.get(VAULT)?.calendars['primary']?.syncToken).toBe('sync-1');
  });

  it('keeps no token when a write fails, so the next sync asks for the same changes again', async () => {
    const { ports, google, kept, vault } = setUp();
    await syncMeetings(ports, {
      vault: VAULT,
      timeZone: ZONE,
      setting: PRIMARY,
      blocksCalendarId: null,
    });
    google.change('primary', meeting({ title: 'Payroll standup (moved)' }));
    const refusing = {
      ...ports,
      fs: { ...ports.fs, writeTextFile: async () => Promise.reject(new Error('the disk is full')) },
    };
    const report = await syncMeetings(refusing, {
      vault: VAULT,
      timeZone: ZONE,
      setting: PRIMARY,
      blocksCalendarId: null,
    });
    expect(report.problem?.problem).toBe('the disk is full');
    expect(kept.get(VAULT)?.calendars['primary']?.syncToken).toBe('sync-1');
    expect(vault.properties(NOTE)).toMatchObject({ title: 'Payroll standup' });
  });

  it('says a refused sign-in in the person’s words', async () => {
    const { google, sync } = setUp();
    google.state.next = new GoogleCalendarError({
      kind: 'token_refused',
      code: 'invalid_grant',
      message: '',
    });
    expect((await sync()).problem?.problem).toContain('expired or was revoked');
  });
});

describe('syncMeetings: one calendar failing', () => {
  const TEAM = 'team@example.com';
  const both = { setting: { enabled: true, calendars: ['primary', TEAM] } };

  it('syncs the others, names the one that failed, and keeps where that one left off', async () => {
    const { vault, google, kept, ports, sync } = setUp();
    google.state.calendars[TEAM] = [meeting({ id: 'ev-retro', calendarId: TEAM, title: 'Retro' })];
    await sync(both);
    const before = kept.get(VAULT)?.calendars[TEAM];
    google.change('primary', meeting({ title: 'Payroll standup (moved)' }));
    const refusingTeam: CalendarSource = {
      listEvents: async (ask) => {
        if (ask.calendarId === TEAM) {
          throw new GoogleCalendarError({ kind: 'api_refused', code: '404', message: 'Not Found' });
        }
        return google.source.listEvents(ask);
      },
    };
    const report = await syncMeetings(
      { ...ports, source: refusingTeam },
      { vault: VAULT, timeZone: ZONE, blocksCalendarId: null, ...both },
    );
    expect(report).toMatchObject({ updated: 1, problem: null, scopeRefused: false });
    expect(report.failed).toEqual([
      {
        calendarId: TEAM,
        problem: expect.objectContaining({ problem: expect.stringContaining('404') }),
      },
    ]);
    expect(vault.properties(NOTE)).toMatchObject({ title: 'Payroll standup (moved)' });
    expect(kept.get(VAULT)?.calendars[TEAM]).toEqual(before);
    expect(meetingSyncProblem(report)?.problem).toMatch(/^team@example.com did not sync: /);
    expect(meetingSyncActivity(report)).toMatchObject({ level: 'warning' });
  });

  it('stops the sync when every calendar failed, as before', async () => {
    const { google, sync } = setUp();
    google.state.next = new GoogleCalendarError({ kind: 'unreachable', message: 'offline' });
    const report = await sync();
    expect(report.problem?.problem).toBe('Google could not be reached: offline.');
    expect(report.failed).toEqual([]);
  });

  it('says when Google refused for want of the read scope, so the sync can wait for it', async () => {
    const { google, sync } = setUp();
    google.state.next = new GoogleCalendarError({
      kind: 'api_refused',
      code: '403',
      message: 'Request had insufficient authentication scopes.',
    });
    const report = await sync();
    expect(report.scopeRefused).toBe(true);
    expect(report.problem?.fix).toMatch(/Allow reading meetings/);
  });
});

describe('syncMeetings: the clock it writes on', () => {
  it('writes on the zone Google gives the calendar, whatever zone the Mac is in', async () => {
    const { vault, sync } = setUp();
    await sync({ timeZone: 'Asia/Tokyo' });
    expect(vault.properties(NOTE)).toMatchObject({
      date: '2026-10-24T09:00',
      ends: '2026-10-24T09:30',
    });
  });
});

describe('syncMeetings: stopped part way', () => {
  it('asks Google nothing once stopped before it lists', async () => {
    const { vault, google, kept, sync } = setUp();
    const report = await sync({ wanted: () => false });
    expect(google.state.asked).toEqual([]);
    expect(report.created).toBe(0);
    expect(vault.files.has(NOTE)).toBe(false);
    expect(kept.get(VAULT)).toBeUndefined();
  });

  it('writes nothing after Stop, and keeps no record, while a sync is under way', async () => {
    const { vault, google, kept, sync } = setUp({
      events: [meeting(), meeting({ id: 'ev-retro', title: 'Retro' })],
    });
    let stopped = false;
    const writes: string[] = [];
    const watched = vault.ports.fs.createNote;
    vault.ports.fs.createNote = async (note) => {
      writes.push(note.path);
      stopped = true;
      return watched(note);
    };
    const report = await sync({ wanted: () => !stopped });
    expect(writes).toHaveLength(1);
    expect(report.created).toBe(1);
    expect(google.state.asked).toHaveLength(1);
    expect(kept.get(VAULT)).toBeUndefined();
  });
});

describe('syncMeetings: which calendars', () => {
  it('reads each calendar named, writes an invitation on two once, and never reads the blocks one', async () => {
    const { vault, google, kept, sync } = setUp();
    google.state.calendars['team@example.com'] = [
      meeting({ calendarId: 'team@example.com' }),
      meeting(
        { id: 'ev-retro', calendarId: 'team@example.com', title: 'Team retro' },
        '2026-10-27',
      ),
    ];
    google.state.calendars['blocks@example.com'] = [
      meeting({ id: 'ev-block', calendarId: 'blocks@example.com' }),
    ];
    const report = await sync({
      setting: { enabled: true, calendars: ['primary', 'team@example.com', 'blocks@example.com'] },
      blocksCalendarId: 'blocks@example.com',
    });
    expect(report).toMatchObject({ created: 2, full: ['primary', 'team@example.com'] });
    expect(google.state.asked.map(({ calendarId }) => calendarId)).toEqual([
      'primary',
      'team@example.com',
    ]);
    expect(vault.properties(NOTE)).toMatchObject({ gcal_calendar: 'primary' });
    expect(Object.keys(kept.get(VAULT)?.calendars ?? {})).toEqual(['primary', 'team@example.com']);
  });

  it('finds a note the last sync made that the index has not caught up with, and makes no second', async () => {
    const { ports, vault, google } = setUp();
    const run: MeetingSyncRun = {
      vault: VAULT,
      timeZone: ZONE,
      setting: PRIMARY,
      blocksCalendarId: null,
    };
    await syncMeetings(ports, run);
    const lagging = {
      ...ports,
      index: {
        query: async (sql: string, parameters: readonly (string | number | null)[]) =>
          sql.includes('meetings: event notes')
            ? { columns: ['path'], rows: [], truncated: false }
            : ports.index.query(sql, parameters),
      },
    };
    google.expire();
    expect(await syncMeetings(lagging, run)).toMatchObject({ created: 0 });
    expect([...vault.files.keys()].filter((path) => path.startsWith('Calendar/'))).toEqual([NOTE]);
  });

  it('links the meeting note a notetaker wrote for the event', async () => {
    const { vault, sync } = setUp({
      notes: {
        'Inbox/Meetings/Payroll standup.md': file({
          type: 'meeting',
          title: 'Payroll standup',
          date: TODAY,
          start: '09:03',
        }),
      },
    });
    await sync();
    expect(vault.properties(NOTE)).toMatchObject({ meeting: '[[Payroll standup]]' });
  });
});

describe('meetingSyncActivity', () => {
  const report: MeetingSyncReport = {
    ran: NOW,
    created: 0,
    updated: 0,
    missing: 0,
    full: [],
    problem: null,
    failed: [],
    scopeRefused: false,
    zoneProblem: null,
  };

  it('says what a sync wrote, counted', () => {
    expect(meetingSyncActivity({ ...report, created: 2, updated: 1, missing: 1 })).toEqual({
      level: 'info',
      kind: 'source',
      message:
        'Meetings from Google Calendar: 2 meetings added, 1 meeting changed, 1 meeting cancelled.',
      subject: null,
    });
  });

  it('says nothing for a sync that found nothing new', () => {
    expect(meetingSyncActivity(report)).toBeNull();
  });

  it('warns with the problem and its fix when a sync stopped', () => {
    const problem = {
      problem: 'Google could not be reached: offline.',
      fix: 'Check the connection and try again.',
    };
    expect(meetingSyncActivity({ ...report, problem })).toMatchObject({
      level: 'warning',
      message:
        'Meetings from Google Calendar did not sync: Google could not be reached: offline. Check the connection and try again.',
    });
  });
});

describe('syncMeetings: the plan zone kept in the vault’s settings (#587)', () => {
  const SETTINGS = '.atlas/settings.md';
  const keptZone = (vault: ReturnType<typeof setUp>['vault']) =>
    vault.files.has(SETTINGS) ? vault.properties(SETTINGS)['google_plan_zone'] : undefined;

  it('keeps the zone the event notes were written on: the primary calendar’s, not the Mac’s', async () => {
    const { vault, sync } = setUp({ zones: { primary: 'America/Chicago' } });
    await sync();
    expect(vault.properties(NOTE)['date']).toBe('2026-10-24T11:00');
    expect(keptZone(vault)).toBe('America/Chicago');
  });

  it('writes the settings once, not on every sync', async () => {
    const { vault, sync } = setUp({ zones: { primary: 'America/Chicago' } });
    await sync();
    const settled = vault.files.get(SETTINGS);
    await sync();
    expect(vault.files.get(SETTINGS)).toBe(settled);
  });

  it('moves the kept zone when the calendar’s moves', async () => {
    const notes = { [SETTINGS]: file({ google_plan_zone: 'America/Los_Angeles' }) };
    const { vault, sync } = setUp({ notes, zones: { primary: 'America/New_York' } });
    await sync();
    expect(keptZone(vault)).toBe('America/New_York');
  });

  it('keeps nothing when no calendar names a zone: the Mac’s is never kept', async () => {
    const { vault, sync } = setUp({ zones: { primary: null } });
    await sync();
    expect(keptZone(vault)).toBeUndefined();
  });

  it('keeps nothing for a sync the person stopped', async () => {
    const { vault, sync } = setUp({ zones: { primary: 'America/Chicago' } });
    await sync({ wanted: () => false });
    expect(keptZone(vault)).toBeUndefined();
  });

  it('still reports the sync whole when the settings refuse the zone', async () => {
    const broken = '---\n: [unclosed\n---\n';
    const { vault, sync } = setUp({
      notes: { [SETTINGS]: broken },
      zones: { primary: 'America/Chicago' },
    });
    const report = await sync();
    expect(report).toMatchObject({ created: 1, problem: null });
    expect(vault.files.get(SETTINGS)).toBe(broken);
  });

  it('says once in Activity why the zone was not kept, and nothing once it is', async () => {
    const broken = '---\n: [unclosed\n---\n';
    const { vault, sync } = setUp({
      notes: { [SETTINGS]: broken },
      zones: { primary: 'America/Chicago' },
    });
    const refused = await sync();
    expect(refused.zoneProblem).toContain("settings.md can't be read");
    expect(meetingSyncActivity(refused)).toMatchObject({
      level: 'warning',
      message: expect.stringContaining(
        'Meetings from Google Calendar synced, but the calendar’s time zone could not be kept',
      ),
    });
    vault.files.set(SETTINGS, file({ theme: 'dark' }));
    const kept = await sync();
    expect(kept.zoneProblem).toBeNull();
    expect(meetingSyncActivity(kept)?.level ?? null).not.toBe('warning');
    expect(keptZone(vault)).toBe('America/Chicago');
  });

  it('lets a fault in DFAI’s own code stop the sync, not pass as a refused write', async () => {
    const { vault, sync } = setUp({ zones: { primary: 'America/Chicago' } });
    const reads = vault.ports.fs.readNotes.bind(vault.ports.fs);
    vault.ports.fs.readNotes = async (paths) => {
      if (paths.includes(SETTINGS)) throw new TypeError('settings is not iterable');
      return reads(paths);
    };
    const report = await sync();
    expect(report.problem?.problem).toContain('settings is not iterable');
  });
});

describe('syncMeetings: the calendar that names the zone failed (#587)', () => {
  const SETTINGS = '.atlas/settings.md';
  const TEAM = 'team@larkspur.example';
  const teamOnly = (calendars: string[]): MeetingSetting => ({ enabled: true, calendars });
  const refusing = (ports: ReturnType<typeof setUp>['ports'], refused: string): CalendarSource => ({
    listEvents: async (ask) => {
      if (ask.calendarId === refused) {
        throw new GoogleCalendarError({ kind: 'api_refused', code: '403', message: 'Forbidden' });
      }
      return ports.source.listEvents(ask);
    },
  });

  it('in a vault that reads no primary, keeps the first calendar’s zone while it fails', async () => {
    const OTHER = 'other@larkspur.example';
    const { vault, ports, google } = setUp({
      notes: { [SETTINGS]: file({ google_plan_zone: 'America/Chicago' }) },
    });
    google.state.calendars[TEAM] = [meeting({ calendarId: TEAM })];
    google.state.calendars[OTHER] = [
      meeting({ id: 'ev-retro', calendarId: OTHER, title: 'Retro' }),
    ];
    const run: MeetingSyncRun = {
      vault: VAULT,
      timeZone: ZONE,
      setting: teamOnly([TEAM, OTHER]),
      blocksCalendarId: null,
    };
    const report = await syncMeetings({ ...ports, source: refusing(ports, TEAM) }, run);
    expect(report.failed.map((failure) => failure.calendarId)).toEqual([TEAM]);
    expect(vault.properties(SETTINGS)['google_plan_zone']).toBe('America/Chicago');
    // The other calendar's note is written on the zone kept, not on its own (the fake's Los Angeles).
    expect(vault.properties('Calendar/2026-10-24 Retro.md')['date']).toBe('2026-10-24T11:00');
  });
});

describe('syncMeetings: the kept zone moves (#587)', () => {
  const SETTINGS = '.atlas/settings.md';
  const chicago = () => {
    const zones: Record<string, string | null> = { primary: 'America/Chicago' };
    return { zones, ...setUp({ zones }) };
  };

  it('lists every calendar again in full once, and writes each note on the new zone', async () => {
    const { vault, google, zones, sync } = chicago();
    await sync();
    expect(vault.properties(NOTE)['date']).toBe('2026-10-24T11:00');
    zones['primary'] = 'America/New_York';
    const asked = google.state.asked.length;
    const moved = await sync();
    // Changes first, which name the new zone, then the window in full.
    expect(google.state.asked.slice(asked).map((ask) => ask.syncToken === null)).toEqual([
      false,
      true,
    ]);
    expect(moved).toMatchObject({ updated: 1, full: ['primary'] });
    expect(vault.properties(NOTE)).toMatchObject({
      date: '2026-10-24T12:00',
      ends: '2026-10-24T12:30',
    });
    expect(vault.properties(SETTINGS)['google_plan_zone']).toBe('America/New_York');
  });

  it('rewrites only the times, byte for byte elsewhere, and then leaves the note be', async () => {
    const { vault, google, zones, sync } = chicago();
    await sync();
    vault.files.set(NOTE, `${vault.files.get(NOTE)}\nPrep James wrote.\n`);
    zones['primary'] = 'America/New_York';
    await sync();
    const rewritten = vault.files.get(NOTE) ?? '';
    expect(rewritten).toContain('Prep James wrote.');
    expect(rewritten).toContain('"date":"2026-10-24T12:00"');
    const asked = google.state.asked.length;
    const settled = await sync();
    expect(settled).toMatchObject({ updated: 0, created: 0 });
    expect(google.state.asked.slice(asked).every((ask) => ask.syncToken !== null)).toBe(true);
    expect(vault.files.get(NOTE)).toBe(rewritten);
  });

  it('lists nothing again when the zone was never kept: the notes were on it already', async () => {
    const { google, sync } = setUp({ zones: { primary: 'America/Chicago' } });
    await sync();
    const asked = google.state.asked.length;
    await sync();
    expect(google.state.asked.slice(asked).every((ask) => ask.syncToken !== null)).toBe(true);
  });

  it('keeps the old zone, and the notes on it, when the relisting fails', async () => {
    const { vault, google, zones, sync } = chicago();
    await sync();
    zones['primary'] = 'America/New_York';
    const first = google.source.listEvents;
    let calls = 0;
    google.source.listEvents = async (ask) => {
      calls += 1;
      if (calls === 2) throw new GoogleCalendarError({ kind: 'unreachable', message: 'offline' });
      return first(ask);
    };
    const report = await sync();
    expect(report.problem).not.toBeNull();
    expect(vault.properties(NOTE)['date']).toBe('2026-10-24T11:00');
    expect(vault.properties(SETTINGS)['google_plan_zone']).toBe('America/Chicago');
  });
});

describe('verification #592: no note in the window is left on another clock than the kept one (#587)', () => {
  const SETTINGS = '.atlas/settings.md';
  const TEAM = 'team@larkspur.example';
  const RETRO = 'Calendar/2026-10-24 Retro.md';
  const BOTH: MeetingSetting = { enabled: true, calendars: ['primary', TEAM] };
  const twoCalendars = (
    zones: Record<string, string | null>,
    notes: Record<string, string> = {},
  ) => {
    const set = setUp({ zones, notes });
    set.google.state.calendars[TEAM] = [
      meeting({ id: 'ev-retro', calendarId: TEAM, title: 'Retro', attendees: [self] }),
    ];
    return { ...set, syncBoth: () => set.sync({ setting: BOTH }) };
  };
  const refusing = (
    google: ReturnType<typeof setUp>['google'],
    refuse: (ask: { calendarId: string; syncToken: string | null }) => boolean,
  ) => {
    const list = google.source.listEvents;
    google.source.listEvents = async (ask) => {
      if (refuse(ask)) {
        throw new GoogleCalendarError({ kind: 'unreachable', message: 'timed out' });
      }
      return list(ask);
    };
    return () => {
      google.source.listEvents = list;
    };
  };

  it('a calendar that fails the relisting of a move is listed in full next time, on the new zone', async () => {
    const zones: Record<string, string | null> = {
      primary: 'America/Chicago',
      [TEAM]: 'Europe/London',
    };
    const { vault, google, syncBoth } = twoCalendars(zones);
    await syncBoth();
    expect(vault.properties(RETRO)['date']).toBe('2026-10-24T11:00');
    zones['primary'] = 'America/New_York';
    // The team calendar answers what changed, then times out when listed in full.
    const restore = refusing(google, (ask) => ask.calendarId === TEAM && ask.syncToken === null);
    const moved = await syncBoth();
    expect(moved.failed.map((failure) => failure.calendarId)).toEqual([TEAM]);
    expect(vault.properties(SETTINGS)['google_plan_zone']).toBe('America/New_York');
    restore();
    await syncBoth();
    expect(vault.properties(NOTE)['date']).toBe('2026-10-24T12:00');
    expect(vault.properties(RETRO)).toMatchObject({
      date: '2026-10-24T12:00',
      ends: '2026-10-24T12:30',
    });
  });

  it('with no zone kept and the primary refused, the team’s notes end on the primary’s zone once it answers', async () => {
    const zones: Record<string, string | null> = {
      primary: 'America/Chicago',
      [TEAM]: 'Europe/London',
    };
    const { vault, google, syncBoth } = twoCalendars(zones);
    const restore = refusing(google, (ask) => ask.calendarId === 'primary');
    await syncBoth();
    // Nothing kept: readers read on the Mac's zone (Los Angeles), so the note is not on London's.
    expect(vault.properties(RETRO)['date']).not.toBe('2026-10-24T17:00');
    restore();
    await syncBoth();
    expect(vault.properties(SETTINGS)['google_plan_zone']).toBe('America/Chicago');
    expect(vault.properties(RETRO)).toMatchObject({
      date: '2026-10-24T11:00',
      ends: '2026-10-24T11:30',
    });
    expect(vault.properties(NOTE)['date']).toBe('2026-10-24T11:00');
  });

  it('says both what a sync wrote and why the zone was not kept, and a failed calendar hides neither', async () => {
    const report: MeetingSyncReport = {
      ran: NOW,
      created: 2,
      updated: 0,
      missing: 0,
      full: [],
      problem: null,
      failed: [
        {
          calendarId: TEAM,
          problem: { problem: 'Google could not be reached: offline.', fix: null },
        },
      ],
      scopeRefused: false,
      zoneProblem: 'the disk is full',
    };
    // Flattened, so it reads one line or many alike.
    const lines = [meetingSyncActivity(report)].flat().filter((line) => line !== null);
    const messages = lines.map((line) => line.message);
    expect(messages).toContainEqual(
      expect.stringContaining('could not be kept in the vault’s settings: the disk is full'),
    );
    expect(messages).toContainEqual(expect.stringContaining(`${TEAM} did not sync`));
    const clean = [meetingSyncActivity({ ...report, failed: [] })]
      .flat()
      .filter((line) => line !== null);
    expect(clean.map((line) => line.message)).toContainEqual(
      'Meetings from Google Calendar: 2 meetings added.',
    );
    expect(clean.map((line) => line.message)).toContainEqual(
      expect.stringContaining('the disk is full'),
    );
  });
});
