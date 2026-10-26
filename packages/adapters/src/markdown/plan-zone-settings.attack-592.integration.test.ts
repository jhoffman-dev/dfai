/**
 * Attack on PR #592 (#587): `google_plan_zone` in a hand-edited
 * `.atlas/settings.md`, against the real YAML port. Byte-preserving
 * (ADR-0003), nothing else changes, no churn, a bad zone never crashes and
 * reads as none. Fictional data only.
 */
import { describe, expect, it } from 'vitest';
import {
  createSettingsWriter,
  fakeCalendarSource,
  memoryMeetingSyncRecords,
  readPlanZone,
  syncMeetings,
  type MeetingSyncRun,
} from '@dfai/application';
import { automationVault } from '@dfai/application/testing/sqlite';
import type { GoogleEvent } from '@dfai/domain';
import { remarkMarkdown } from './markdown-port.ts';

const TODAY = '2026-10-24';
const SETTINGS = '.atlas/settings.md';

const standup: GoogleEvent = {
  id: 'ev-standup',
  calendarId: 'primary',
  status: 'confirmed',
  title: 'Payroll standup',
  start: { kind: 'timed', at: Date.parse('2026-10-24T16:00:00Z') },
  end: { kind: 'timed', at: Date.parse('2026-10-24T16:30:00Z') },
  attendees: [],
  recurringEventId: null,
  eventType: 'default',
};

function setUp(settings: string) {
  const vault = automationVault({
    today: TODAY,
    notes: { [SETTINGS]: settings },
    markdown: remarkMarkdown,
  });
  const google = fakeCalendarSource({ primary: [standup] }, { primary: 'America/Chicago' });
  const { records } = memoryMeetingSyncRecords();
  const writer = createSettingsWriter({ fs: vault.ports.fs, markdown: vault.ports.markdown });
  const ports = {
    source: google.source,
    records,
    fs: vault.ports.fs,
    markdown: vault.ports.markdown,
    index: vault.ports.index,
    clock: { today: () => TODAY, now: () => Date.parse('2026-10-24T14:00:00Z') },
    settings: writer,
  };
  const run: MeetingSyncRun = {
    vault: '/Users/someone/Vault',
    timeZone: 'America/Los_Angeles',
    setting: { enabled: true, calendars: ['primary'] },
    blocksCalendarId: null,
  };
  return {
    vault,
    writer,
    settingsText: () => vault.files.get(SETTINGS) ?? '',
    sync: () => syncMeetings(ports, run),
    planZone: () => readPlanZone({ fs: vault.ports.fs, markdown: vault.ports.markdown }),
  };
}

const HAND_EDITED = [
  '---',
  '# Settings James edits by hand',
  'vault_id: 7d3f0c2e-5a41-4b8e-9c61-0f2d4a9b1e57',
  'google_meetings: true',
  'sidebar_order:   [Inbox, Today,   Projects]   # odd spacing',
  'larkspur_note: "kept as typed"',
  '---',
  '',
  '# Settings',
  '',
].join('\r\n');

describe('attack #592: google_plan_zone in a hand-edited settings note', () => {
  it('adds the zone and leaves every other byte of a CRLF, commented settings note as it was', async () => {
    const { settingsText, sync } = setUp(HAND_EDITED);
    await sync();
    const after = settingsText();
    expect(after).toContain('google_plan_zone');
    const added = after.split('\r\n').filter((line) => !HAND_EDITED.split('\r\n').includes(line));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^google_plan_zone: ['"]?America\/Chicago['"]?$/);
  });

  it('writes nothing on the second sync of a hand-edited note', async () => {
    const { settingsText, sync } = setUp(HAND_EDITED);
    await sync();
    const settled = settingsText();
    await sync();
    expect(settingsText()).toBe(settled);
  });

  it('reads a zone James typed in odd case as the zone, and writes nothing over it', async () => {
    const typed = HAND_EDITED.replace(
      'google_meetings: true',
      'google_meetings: true\r\ngoogle_plan_zone: america/chicago',
    );
    const { settingsText, sync, planZone } = setUp(typed);
    expect(await planZone()).not.toBeNull();
    await sync();
    // It names the zone the calendar keeps already: rewriting it is churn on James's text.
    expect(settingsText()).toBe(typed);
  });

  it('reads a zone James typed with spaces round it, and writes nothing over it', async () => {
    const typed = HAND_EDITED.replace(
      'google_meetings: true',
      "google_meetings: true\r\ngoogle_plan_zone: ' America/Chicago '",
    );
    const { settingsText, sync, planZone } = setUp(typed);
    expect(await planZone()).toBe('America/Chicago');
    await sync();
    expect(settingsText()).toBe(typed);
  });

  it('reads a zone no clock knows as none, without throwing', async () => {
    const typed = HAND_EDITED.replace(
      'google_meetings: true',
      'google_meetings: true\r\ngoogle_plan_zone: Mars/Olympus_Mons',
    );
    const { planZone } = setUp(typed);
    expect(await planZone()).toBeNull();
  });

  it('reads a non-text zone (a list, a number) as none, without throwing', async () => {
    for (const value of ['[America/Chicago]', '42', '~', '{a: 1}']) {
      const typed = HAND_EDITED.replace(
        'google_meetings: true',
        `google_meetings: true\r\ngoogle_plan_zone: ${value}`,
      );
      const { planZone } = setUp(typed);
      expect(await planZone()).toBeNull();
    }
  });

  it('keeps a vault_id saved while the zone is kept: one writer, both land', async () => {
    const { settingsText, sync, writer } = setUp(HAND_EDITED);
    const vaultId = 'c0a8e1f4-2b6d-4f3a-8e9b-5d7c1a2f3e40';
    await Promise.all([
      sync(),
      writer.save({ vault_id: vaultId }),
      writer.update((current) => ({ blocks_sync: current['blocks_sync'] !== true })),
    ]);
    const after = settingsText();
    expect(after).toContain('google_plan_zone');
    expect(after).toContain(vaultId);
    expect(after).toContain('blocks_sync: true');
    expect(after).toContain('larkspur_note: "kept as typed"');
  });

  it('leaves a settings note with merge-conflict markers byte for byte, and reads no zone', async () => {
    const conflicted = [
      '---',
      'google_meetings: true',
      '<<<<<<< HEAD',
      'google_plan_zone: America/Chicago',
      '=======',
      'google_plan_zone: America/New_York',
      '>>>>>>> origin/main',
      '---',
      '',
    ].join('\n');
    const { settingsText, sync, planZone } = setUp(conflicted);
    expect(await planZone()).toBeNull();
    const report = await sync();
    expect(report.problem).toBeNull();
    expect(settingsText()).toBe(conflicted);
  });
});
