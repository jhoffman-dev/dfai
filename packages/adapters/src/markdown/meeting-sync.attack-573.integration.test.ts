/**
 * Attack on PR #573 (#31, ADR-0046): the meetings sync against the real
 * YAML port, on notes the person has edited by hand.
 */
import { describe, expect, it } from 'vitest';
import {
  fakeCalendarSource,
  memoryMeetingSyncRecords,
  syncMeetings,
  type MeetingSyncRun,
} from '@dfai/application';
import { automationVault } from '@dfai/application/testing/sqlite';
import type { GoogleEvent } from '@dfai/domain';
import { remarkMarkdown } from './markdown-port.ts';

const TODAY = '2026-10-24';
const NOTE = 'Calendar/2026-10-24 Payroll standup.md';

const standup = (overrides: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id: 'ev-standup',
  calendarId: 'primary',
  status: 'confirmed',
  title: 'Payroll standup',
  start: { kind: 'timed', at: Date.parse('2026-10-24T16:00:00Z') },
  end: { kind: 'timed', at: Date.parse('2026-10-24T16:30:00Z') },
  attendees: [],
  recurringEventId: null,
  eventType: 'default',
  ...overrides,
});

function setUp() {
  const vault = automationVault({ today: TODAY, notes: {}, markdown: remarkMarkdown });
  const google = fakeCalendarSource({ primary: [standup()] });
  const { records } = memoryMeetingSyncRecords();
  const ports = {
    source: google.source,
    records,
    fs: vault.ports.fs,
    markdown: vault.ports.markdown,
    index: vault.ports.index,
    clock: { today: () => TODAY, now: () => Date.parse('2026-10-24T14:00:00Z') },
  };
  const run: MeetingSyncRun = {
    vault: '/Users/someone/Vault',
    timeZone: 'America/Los_Angeles',
    setting: { enabled: true, calendars: ['primary'] },
    blocksCalendarId: null,
  };
  return { vault, google, sync: () => syncMeetings(ports, run) };
}

const calendarNotes = (files: ReadonlyMap<string, string>) =>
  [...files.keys()].filter((path) => path.startsWith('Calendar/')).sort();

describe('attack #573: a hand-edited event note, real YAML', () => {
  it('rewrites only the owned keys: the person’s keys, comments and CRLF body stay byte-identical', async () => {
    const { vault, google, sync } = setUp();
    await sync();
    const made = vault.files.get(NOTE) ?? '';
    const body =
      '## Prep\r\n\r\n- ask about the Q4 close %%private%%\r\n---\r\nnot frontmatter\r\n';
    const edited = made.replace(/\n---\n$/, '\nmood: calm # James wrote this\n---\n') + body;
    vault.files.set(NOTE, edited);
    google.change('primary', standup({ title: 'Payroll standup (moved)' }));
    expect(await sync()).toMatchObject({ updated: 1, problem: null });
    const after = vault.files.get(NOTE) ?? '';
    expect(after.endsWith(body)).toBe(true);
    expect(after).toContain('mood: calm # James wrote this');
    expect(vault.properties(NOTE)).toMatchObject({ title: 'Payroll standup (moved)' });
  });

  it('makes no second note for an event whose note’s frontmatter the person broke', async () => {
    const { vault, google, sync } = setUp();
    await sync();
    const made = vault.files.get(NOTE) ?? '';
    // A stray line typed into the frontmatter: no longer YAML.
    vault.files.set(NOTE, made.replace(/\n---\n$/, '\n: oops [\n---\nPrep I wrote.\n'));
    google.change('primary', standup({ title: 'Payroll standup (moved)' }));
    google.expire();
    await sync();
    expect(calendarNotes(vault.files)).toEqual([NOTE]);
  });
});
