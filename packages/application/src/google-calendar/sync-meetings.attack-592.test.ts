/**
 * Attack on PR #592 (#587): the plan zone the meetings sync keeps. One
 * calendar Google refuses for a sync must not move the zone every event note
 * already written is on. Fictional data only.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath, wallTimeIn, type GoogleEvent, type MeetingSetting } from '@dfai/domain';
import { automationVault, sqliteIndexPort } from '@dfai/application/testing/sqlite';
import type { IndexPort } from '../index/ports.ts';
import { toIndexedNote } from '../index/to-indexed-note.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { createSettingsWriter } from '../settings/settings-writer.ts';
import { fakeCalendarSource, memoryMeetingSyncRecords } from '../testing/fake-google-calendar.ts';
import { GoogleCalendarError, type CalendarSource } from './ports.ts';
import { syncMeetings } from './sync-meetings.ts';

const VAULT = '/Users/someone/Vault';
const TODAY = '2026-10-24';
const NOW = Date.parse('2026-10-24T14:00:00Z');
const TEAM = 'team@larkspur.example';
const SETTINGS = '.atlas/settings.md';
const BOTH: MeetingSetting = { enabled: true, calendars: ['primary', TEAM] };

const meeting = (overrides: Partial<GoogleEvent>): GoogleEvent => ({
  id: 'ev-standup',
  calendarId: 'primary',
  status: 'confirmed',
  title: 'Payroll standup',
  start: { kind: 'timed', at: Date.parse(`${TODAY}T16:00:00Z`) },
  end: { kind: 'timed', at: Date.parse(`${TODAY}T16:30:00Z`) },
  attendees: [],
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

function setUp() {
  const vault = automationVault({ today: TODAY, notes: {} });
  const zones: Record<string, string | null> = {
    primary: 'America/Chicago',
    [TEAM]: 'Europe/London',
  };
  const google = fakeCalendarSource(
    {
      primary: [meeting({})],
      [TEAM]: [meeting({ id: 'ev-retro', calendarId: TEAM, title: 'Retro' })],
    },
    zones,
  );
  const { records } = memoryMeetingSyncRecords();
  const ports = {
    source: google.source,
    records,
    fs: vault.ports.fs,
    markdown: vault.ports.markdown,
    index: liveIndex(vault.files, vault.ports.markdown),
    clock: { today: () => TODAY, now: () => NOW },
    settings: createSettingsWriter({ fs: vault.ports.fs, markdown: vault.ports.markdown }),
  };
  const run = {
    vault: VAULT,
    timeZone: 'America/Los_Angeles',
    setting: BOTH,
    blocksCalendarId: null,
  };
  const refusingPrimary: CalendarSource = {
    listEvents: async (ask) => {
      if (ask.calendarId === 'primary') {
        throw new GoogleCalendarError({ kind: 'api_refused', code: '403', message: 'Forbidden' });
      }
      return google.source.listEvents(ask);
    },
  };
  const keptZone = () => vault.properties(SETTINGS)['google_plan_zone'];
  return {
    vault,
    zones,
    keptZone,
    sync: () => syncMeetings(ports, run),
    syncRefusingPrimary: () => syncMeetings({ ...ports, source: refusingPrimary }, run),
  };
}

describe('attack #592: a calendar refused for one sync', () => {
  it('keeps the primary calendar’s zone when Google refuses primary for one sync (403)', async () => {
    const { keptZone, sync, syncRefusingPrimary } = setUp();
    await sync();
    expect(keptZone()).toBe('America/Chicago');
    await syncRefusingPrimary();
    // The primary's event notes are still on Chicago's clock; moving the kept
    // zone to the team calendar's would read them all on London's.
    expect(keptZone()).toBe('America/Chicago');
  });
});

describe('attack #592: the kept zone is the clock the event notes are on', () => {
  it('leaves no event note on the old clock once the primary calendar’s zone moves', async () => {
    const { vault, zones, keptZone, sync } = setUp();
    await sync();
    const note = [...vault.files.keys()].find((path) => path.includes('Payroll standup'))!;
    expect(vault.properties(note)['date']).toBe('2026-10-24T11:00');
    // James moves; Google's primary calendar now keeps New York time. Nothing about the
    // standup itself changed, so an incremental listing does not hand it back.
    zones['primary'] = 'America/New_York';
    await sync();
    expect(keptZone()).toBe('America/New_York');
    const start = Date.parse(`${TODAY}T16:00:00Z`);
    // Read on the kept zone, the note must still say when the standup starts.
    expect(vault.properties(note)['date']).toBe(wallTimeIn('America/New_York', start).slice(0, 16));
  });
});
