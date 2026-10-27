import { describe, expect, it } from 'vitest';
import { createSettingsWriter } from '../settings/settings-writer.ts';
import { blockEventId, createVaultPath } from '@dfai/domain';
import { automationVault, sqliteIndexPort } from '@dfai/application/testing/sqlite';
import type { IndexPort } from '../index/ports.ts';
import { toIndexedNote } from '../index/to-indexed-note.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { fakeBlockCalendar, memoryBlockSyncRecords } from '../testing/fake-google-calendar.ts';
import { blockSyncActivity, blockSyncProblem } from './block-sync-activity.ts';
import { GoogleCalendarError } from './ports.ts';
import { syncBlocks, type BlockSyncRun } from './sync-blocks.ts';

const VAULT = '/Users/someone/Vault';
const CALENDAR = 'dfai-blocks@group.calendar.example.com';
const TODAY = '2026-10-25';
const NOW = Date.parse('2026-10-25T16:00:00Z');
const BLOCK = 'Larkspur close block.md';
const SETTINGS = '.atlas/settings.md';
/** The vault's own id, in its settings: one of the seeds of a new block's event id. */
const VAULT_ID = 'k3v9q0m2b7hd5t1e';
const drawn = (attempt: number, path = BLOCK) =>
  blockEventId({ vaultId: VAULT_ID, calendarId: CALENDAR, path, attempt });

const file = (properties: Record<string, unknown>, body = '') =>
  `---\n${JSON.stringify(properties)}\n---\n${body}`;

const blockFile = (more: Record<string, unknown> = {}, body = 'Bring the Q4 numbers.\n') =>
  file(
    {
      type: 'block',
      start: '2026-10-26T09:00',
      end: '2026-10-26T10:00',
      tasks: ['[[Close the books]]'],
      owner: 'Mara Quill',
      ...more,
    },
    body,
  );

/** The index as the app builds it, rebuilt from the files for every query. */
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

function setUp(
  notes: Record<string, string> = { [BLOCK]: blockFile() },
  {
    extraPaths = [],
    settings = file({ vault_id: VAULT_ID }),
  }: { extraPaths?: string[]; settings?: string | null } = {},
) {
  const vault = automationVault({
    today: TODAY,
    notes: settings === null ? notes : { [SETTINGS]: settings, ...notes },
  });
  const google = fakeBlockCalendar();
  // The fake keeps Los Angeles time; the person's primary calendar is on it too.
  google.state.primaryZone = 'America/Los_Angeles';
  const { records, kept } = memoryBlockSyncRecords();
  const queries: string[] = [];
  const live = liveIndex(vault.files, vault.ports.markdown);
  const ports = {
    calendar: google.calendar,
    records,
    fs: vault.ports.fs,
    markdown: vault.ports.markdown,
    index: {
      query: async (sql: string, parameters: readonly (string | number | null)[]) => {
        queries.push(sql);
        const result = await live.query(sql, parameters);
        return { ...result, rows: [...result.rows, ...extraPaths.map((path) => [path])] };
      },
    },
    clock: { today: () => TODAY, now: () => NOW },
    settings: createSettingsWriter({ fs: vault.ports.fs, markdown: vault.ports.markdown }),
  };
  const run: BlockSyncRun = { vault: VAULT, calendarId: CALENDAR, timeZone: 'Europe/London' };
  const props = (path = BLOCK) =>
    JSON.parse(vault.files.get(path)?.split('\n')[1] ?? '{}') as Record<string, unknown>;
  return {
    vault,
    google,
    kept,
    props,
    queries,
    sync: (overrides: Partial<BlockSyncRun> = {}) => syncBlocks(ports, { ...run, ...overrides }),
  };
}

describe('syncBlocks: a new block', () => {
  it('becomes a busy event on the blocks calendar, its id and version written on the block, nothing else touched', async () => {
    const { vault, google, props, kept, sync } = setUp();
    const report = await sync();
    expect(report).toMatchObject({
      inserted: 1,
      pushed: 0,
      pulled: 0,
      missing: 0,
      failed: [],
      full: true,
    });
    const [write] = google.state.writes;
    expect(write?.kind).toBe('insert');
    expect(write?.call).toMatchObject({
      calendarId: CALENDAR,
      fields: { title: 'Larkspur close block', start: '2026-10-26T09:00', end: '2026-10-26T10:00' },
      // The plan zone: the primary calendar's, as meetings are written on (ADR-0046).
      timeZone: 'America/Los_Angeles',
      notePath: BLOCK,
    });
    const id = write?.call.eventId ?? '';
    // Drawn from the calendar and the path, so another Mac pushing it too sends the same id.
    expect(id).toBe(drawn(0));
    expect(props()).toEqual({
      type: 'block',
      start: '2026-10-26T09:00',
      end: '2026-10-26T10:00',
      tasks: ['[[Close the books]]'],
      owner: 'Mara Quill',
      gcal_event_id: id,
      gcal_calendar: CALENDAR,
      gcal_synced_title: 'Larkspur close block',
      gcal_synced_start: '2026-10-26T09:00',
      gcal_synced_end: '2026-10-26T10:00',
      gcal_etag: '"g1"',
    });
    expect(vault.files.get(BLOCK)?.endsWith('\nBring the Q4 numbers.\n')).toBe(true);
    expect(kept.get(VAULT)).toMatchObject({
      calendarId: CALENDAR,
      syncToken: 'blocks-sync-1',
      lastSyncAt: NOW,
    });
  });

  it('writes on the primary calendar’s zone, else the Mac’s, never the blocks calendar’s own', async () => {
    const primary = setUp();
    primary.google.state.zone = 'UTC';
    primary.google.state.primaryZone = 'America/Chicago';
    await primary.sync();
    expect(primary.google.state.writes[0]?.call.timeZone).toBe('America/Chicago');
    const mac = setUp();
    mac.google.state.zone = 'UTC';
    mac.google.state.primaryZone = null;
    await mac.sync();
    expect(mac.google.state.writes[0]?.call.timeZone).toBe('Europe/London');
  });

  it('a primary zone Google will not give stops the sync before anything is written', async () => {
    const { vault, google, kept, sync } = setUp();
    const before = vault.files.get(BLOCK);
    google.state.failNext.zone = new GoogleCalendarError({
      kind: 'unreachable',
      message: 'offline',
    });
    const report = await sync();
    expect(report.problem).not.toBeNull();
    expect(google.state.writes).toEqual([]);
    expect(vault.files.get(BLOCK)).toBe(before);
    expect(kept.has(VAULT)).toBe(false);
  });

  it('does not come back as a pull: the next sync, hearing its own insert, writes nothing', async () => {
    const { vault, google, sync } = setUp();
    await sync();
    const after = vault.files.get(BLOCK);
    const report = await sync();
    expect(google.state.asked.at(-1)?.syncToken).toBe('blocks-sync-1');
    expect(report).toMatchObject({ inserted: 0, pushed: 0, pulled: 0, missing: 0 });
    expect(google.state.writes).toHaveLength(1);
    expect(vault.files.get(BLOCK)).toBe(after);
    expect(blockSyncActivity(report)).toEqual([]);
  });

  it('an insert that failed is tried again with the same id, so Google never holds two', async () => {
    const { google, props, kept, sync } = setUp();
    google.state.failNext.insert = new GoogleCalendarError({
      kind: 'unreachable',
      message: 'offline',
    });
    const first = await sync();
    expect(first.failed.map((failure) => failure.path)).toEqual([BLOCK]);
    const id = props()['gcal_event_id'];
    expect(typeof id).toBe('string');
    expect(props()['gcal_etag']).toBeUndefined();
    // The token stays where it was, so the same changes are read again.
    expect(kept.get(VAULT)?.syncToken).toBeNull();
    await sync();
    expect(google.state.writes.map((write) => [write.kind, write.call.eventId])).toEqual([
      ['insert', id],
      ['insert', id],
    ]);
    expect(google.state.events.size).toBe(1);
    expect(props()['gcal_etag']).toBe('"g1"');
  });

  it('an insert that landed but whose version was not written is patched, not made twice', async () => {
    const { google, props, sync } = setUp({
      [BLOCK]: blockFile({ gcal_event_id: 'dfaiheld1', gcal_calendar: CALENDAR }),
    });
    google.state.events.set('dfaiheld1', {
      id: 'dfaiheld1',
      etag: '"g0"',
      cancelled: false,
      title: 'Larkspur close block',
      start: { kind: 'timed', at: Date.parse('2026-10-26T16:00:00Z') },
      end: { kind: 'timed', at: Date.parse('2026-10-26T17:00:00Z') },
    });
    // A token from before the insert, so the listing does not include it.
    google.expire();
    const report = await sync();
    // The full listing found it, with the block's own times: only its version is taken.
    expect(report.inserted).toBe(0);
    expect(props()['gcal_etag']).toBe('"g0"');
    expect(google.state.writes).toEqual([]);
  });
});

describe('syncBlocks: moving a block', () => {
  it('moved in DFAI, the event is patched to match', async () => {
    const { vault, google, props, sync } = setUp();
    await sync();
    const id = String(props()['gcal_event_id']);
    vault.files.set(
      BLOCK,
      blockFile({ ...props(), start: '2026-10-26T13:00', end: '2026-10-26T14:30' }),
    );
    const report = await sync();
    expect(report.pushed).toBe(1);
    expect(google.state.writes.at(-1)).toMatchObject({
      kind: 'patch',
      call: { eventId: id, fields: { start: '2026-10-26T13:00', end: '2026-10-26T14:30' } },
    });
    expect(props()['gcal_etag']).toBe('"g2"');
  });

  it('what a push sends is on the block, as agreed, before it is sent', async () => {
    const { vault, google, props, sync } = setUp();
    await sync();
    vault.files.set(
      BLOCK,
      blockFile({ ...props(), start: '2026-10-26T13:00', end: '2026-10-26T14:00' }),
    );
    let onBlockWhenSent: Record<string, unknown> = {};
    const patch = google.calendar.patchBlockEvent;
    google.calendar.patchBlockEvent = async (call) => {
      onBlockWhenSent = props();
      return patch(call);
    };
    await sync();
    expect(onBlockWhenSent).toMatchObject({
      gcal_synced_start: '2026-10-26T13:00',
      gcal_synced_end: '2026-10-26T14:00',
    });
    // Marked pending, its version still the last Google confirmed, until Google answers.
    expect(onBlockWhenSent).toMatchObject({ gcal_pending: true, gcal_etag: '"g1"' });
    expect(props()['gcal_etag']).toBe('"g2"');
    expect(props()).not.toHaveProperty('gcal_pending');
  });

  it('a push that never landed is sent again, though its agreed record was written', async () => {
    const { vault, google, props, sync } = setUp();
    await sync();
    await sync();
    const id = String(props()['gcal_event_id']);
    vault.files.set(
      BLOCK,
      blockFile({ ...props(), start: '2026-10-26T13:00', end: '2026-10-26T14:00' }),
    );
    google.state.failNext.patch = new GoogleCalendarError({
      kind: 'unreachable',
      message: 'offline',
    });
    const failed = await sync();
    expect(failed.failed.map((failure) => failure.path)).toEqual([BLOCK]);
    // Google never heard of the move, and lists nothing new; the block's pending mark says to send it.
    await sync();
    expect(google.state.events.get(id)?.start).toEqual({
      kind: 'timed',
      at: Date.parse('2026-10-26T13:00:00-07:00'),
    });
    expect(props()['gcal_etag']).toBe('"g2"');
  });

  /** Agreed 09:00, moved to 10:00 in DFAI, and the patch that would say so never reaches Google. */
  async function pushNeverLanded() {
    const set = setUp();
    await set.sync();
    await set.sync();
    const id = String(set.props()['gcal_event_id']);
    set.vault.files.set(
      BLOCK,
      blockFile({ ...set.props(), start: '2026-10-26T10:00', end: '2026-10-26T11:00' }),
    );
    set.google.state.failNext.patch = new GoogleCalendarError({
      kind: 'unreachable',
      message: 'offline',
    });
    expect((await set.sync()).failed.map((failure) => failure.path)).toEqual([BLOCK]);
    return { ...set, id };
  }

  it('a push that never landed survives a full listing (a lost token): it is sent again, not undone', async () => {
    const { google, props, sync, id } = await pushNeverLanded();
    google.expire();
    const report = await sync();
    expect(report).toMatchObject({ full: true, pushed: 1, pulled: 0, conflicts: [] });
    expect(props()).toMatchObject({ start: '2026-10-26T10:00', end: '2026-10-26T11:00' });
    expect(props()).not.toHaveProperty('gcal_pending');
    expect(google.state.events.get(id)?.start).toEqual({
      kind: 'timed',
      at: Date.parse('2026-10-26T10:00:00-07:00'),
    });
  });

  it('a push that never landed, the event changed in Google since: Google is kept, and Activity says so', async () => {
    const { google, props, sync, id } = await pushNeverLanded();
    const kept = google.state.events.get(id);
    if (kept === undefined) throw new Error('no event');
    // A colour or a description: a new version, times as they were.
    google.state.versions += 1;
    google.state.events.set(id, { ...kept, etag: `"g${google.state.versions}"` });
    google.state.changed.add(id);
    google.expire();
    const report = await sync();
    expect(report.conflicts).toEqual([BLOCK]);
    expect(props()).toMatchObject({ start: '2026-10-26T09:00', end: '2026-10-26T10:00' });
    expect(blockSyncActivity(report).map((line) => line.message)).toContain(
      '“Larkspur close block” was changed in DFAI and in Google Calendar; Google’s time was kept.',
    );
  });

  it('moved in Google, the block’s times move on the next sync; its body and other keys stay', async () => {
    const { vault, google, props, sync } = setUp();
    await sync();
    const id = String(props()['gcal_event_id']);
    google.move(id, '2026-10-26T15:00', '2026-10-26T16:00');
    const report = await sync();
    expect(report).toMatchObject({ pulled: 1, conflicts: [] });
    expect(props()).toMatchObject({
      start: '2026-10-26T15:00',
      end: '2026-10-26T16:00',
      gcal_etag: '"g2"',
      owner: 'Mara Quill',
      tasks: ['[[Close the books]]'],
    });
    expect(vault.files.get(BLOCK)?.endsWith('\nBring the Q4 numbers.\n')).toBe(true);
    expect(blockSyncActivity(report).map((line) => line.message)).toEqual([
      'Blocks on Google Calendar: 1 block moved from Google.',
    ]);
    // Pulled, it is not pushed back.
    await sync();
    expect(google.state.writes.filter((write) => write.kind === 'patch')).toEqual([]);
  });

  it('moved on both sides: Google wins, and Activity says so about that block', async () => {
    const { vault, google, props, sync } = setUp();
    await sync();
    const id = String(props()['gcal_event_id']);
    google.move(id, '2026-10-26T15:00', '2026-10-26T16:00');
    vault.files.set(
      BLOCK,
      blockFile({ ...props(), start: '2026-10-26T11:00', end: '2026-10-26T12:00' }),
    );
    const report = await sync();
    expect(report.conflicts).toEqual([BLOCK]);
    expect(props()).toMatchObject({ start: '2026-10-26T15:00', end: '2026-10-26T16:00' });
    expect(google.state.writes.filter((write) => write.kind === 'patch')).toEqual([]);
    const conflict = blockSyncActivity(report).find((line) => line.subject !== null);
    expect(conflict).toEqual({
      level: 'info',
      kind: 'source',
      message:
        '“Larkspur close block” was changed in DFAI and in Google Calendar; Google’s time was kept.',
      subject: { kind: 'note', path: BLOCK },
    });
  });
});

describe('syncBlocks: deleting in Google', () => {
  it('marks the block gcal_missing and never deletes the note or pushes it again', async () => {
    const { vault, google, props, sync } = setUp();
    await sync();
    google.remove(String(props()['gcal_event_id']));
    const report = await sync();
    expect(report.missing).toBe(1);
    expect(vault.files.has(BLOCK)).toBe(true);
    expect(props()['gcal_missing']).toBe(true);
    vault.files.set(
      BLOCK,
      blockFile({ ...props(), start: '2026-10-26T13:00', end: '2026-10-26T14:00' }),
    );
    await sync();
    expect(google.state.writes).toHaveLength(1);
  });

  it('an event restored in Google takes the mark off and brings its times back', async () => {
    const { google, props, sync } = setUp();
    await sync();
    const id = String(props()['gcal_event_id']);
    google.remove(id);
    await sync();
    expect(props()['gcal_missing']).toBe(true);
    google.state.events.delete(id);
    google.state.events.set(id, {
      id,
      etag: '"g9"',
      cancelled: false,
      title: 'Larkspur close block',
      start: { kind: 'timed', at: Date.parse('2026-10-26T18:00:00Z') },
      end: { kind: 'timed', at: Date.parse('2026-10-26T19:00:00Z') },
    });
    google.state.changed.add(id);
    const report = await sync();
    expect(report.pulled).toBe(1);
    expect(props()).toMatchObject({
      start: '2026-10-26T11:00',
      end: '2026-10-26T12:00',
      gcal_etag: '"g9"',
    });
    expect(props()).not.toHaveProperty('gcal_missing');
  });

  it('a patch of an event deleted since the listing marks the block, rather than fail', async () => {
    const { vault, google, props, sync } = setUp();
    await sync();
    // A second sync hears its own insert, so the next listing holds nothing.
    await sync();
    const id = String(props()['gcal_event_id']);
    vault.files.set(
      BLOCK,
      blockFile({ ...props(), start: '2026-10-26T13:00', end: '2026-10-26T14:00' }),
    );
    google.state.events.set(id, { ...google.state.events.get(id)!, cancelled: true });
    const report = await sync();
    expect(report).toMatchObject({ missing: 1, failed: [] });
    expect(google.state.writes.at(-1)?.kind).toBe('patch');
    expect(props()['gcal_missing']).toBe(true);
  });
});

describe('syncBlocks: what goes wrong', () => {
  it('a 410 lists the calendar in full again', async () => {
    const { google, sync } = setUp();
    await sync();
    google.expire();
    const report = await sync();
    expect(report.full).toBe(true);
    expect(google.state.asked.slice(-2).map((ask) => ask.syncToken)).toEqual([
      'blocks-sync-1',
      null,
    ]);
  });

  it('a listing Google refuses writes nothing and keeps no record', async () => {
    const { vault, google, kept, sync } = setUp();
    const before = vault.files.get(BLOCK);
    google.state.failNext.list = new GoogleCalendarError({
      kind: 'unreachable',
      message: 'offline',
    });
    const report = await sync();
    expect(report.problem).not.toBeNull();
    expect(report.scopeRefused).toBe(false);
    expect(vault.files.get(BLOCK)).toBe(before);
    expect(kept.has(VAULT)).toBe(false);
    expect(blockSyncActivity(report)[0]?.level).toBe('warning');
    expect(blockSyncProblem(report)).toBe(report.problem);
  });

  it('a 403 for want of a scope stops the rest and says what to do', async () => {
    const { google, sync } = setUp({
      [BLOCK]: blockFile(),
      'Mara Quill prep block.md': blockFile(),
    });
    google.state.failNext.insert = new GoogleCalendarError({
      kind: 'api_refused',
      code: '403',
      message: 'the Calendar API answered 403: insufficientPermissions',
    });
    const report = await sync();
    expect(report.scopeRefused).toBe(true);
    expect(report.failed).toHaveLength(1);
    expect(google.state.writes).toHaveLength(1);
    expect(blockSyncProblem(report)?.problem).toContain('may not change that calendar');
  });

  it('one block failing is reported by name, and the others still sync', async () => {
    const { google, sync } = setUp({
      'A block.md': blockFile(),
      'B block.md': blockFile(),
    });
    google.state.failNext.insert = new GoogleCalendarError({
      kind: 'api_refused',
      code: '500',
      message: 'the Calendar API answered 500',
    });
    const report = await sync();
    expect(report.inserted).toBe(1);
    expect(report.failed.map((failure) => failure.path)).toEqual(['A block.md']);
    const lines = blockSyncActivity(report);
    expect(lines.find((line) => line.level === 'warning')).toMatchObject({
      subject: { kind: 'note', path: 'A block.md' },
    });
    expect(blockSyncProblem(report)?.problem).toContain('“A block” did not sync');
  });

  it('stopped as the listing comes back, it reads no blocks, writes nothing and keeps no record', async () => {
    const { vault, google, kept, queries, sync } = setUp();
    const before = vault.files.get(BLOCK);
    const report = await sync({ wanted: () => google.state.asked.length === 0 });
    expect(report.inserted).toBe(0);
    expect(queries).toEqual([]);
    expect(google.state.writes).toEqual([]);
    expect(vault.files.get(BLOCK)).toBe(before);
    expect(kept.has(VAULT)).toBe(false);
  });

  it('stopped while Google’s copies of shared events are read, it reads no more and says no problem', async () => {
    const { vault, google, kept, sync } = setUp({
      'A block.md': blockFile(),
      'B block.md': blockFile(),
    });
    await sync();
    // Hearing its own inserts: after this, the listing gives nothing, so the copies' events are read.
    await sync();
    for (const name of ['A block', 'B block']) {
      vault.files.set(`${name} copy.md`, vault.files.get(`${name}.md`) ?? '');
    }
    const record = kept.get(VAULT);
    const writes = google.state.writes.length;
    const report = await sync({ wanted: () => google.state.fetched.length === 0 });
    expect(google.state.fetched).toHaveLength(1);
    expect(report.problem).toBeNull();
    expect(google.state.writes).toHaveLength(writes);
    expect(kept.get(VAULT)).toBe(record);
  });

  it('stopped as Google answers 410, it does not list the calendar again', async () => {
    const { google, kept, sync } = setUp();
    await sync();
    google.expire();
    const record = kept.get(VAULT);
    const report = await sync({ wanted: () => google.state.asked.length < 2 });
    expect(google.state.asked).toHaveLength(2);
    expect(report.problem).toBeNull();
    expect(kept.get(VAULT)).toBe(record);
  });

  it('a pull stopped before its title is put back still counts as pulled', async () => {
    const { google, props, sync } = setUp();
    await sync();
    const id = String(props()['gcal_event_id']);
    google.move(id, '2026-10-26T15:00', '2026-10-26T16:00');
    const kept = google.state.events.get(id);
    if (kept === undefined) throw new Error('no event');
    google.state.events.set(id, { ...kept, title: 'Renamed in Google' });
    const report = await sync({ wanted: () => props()['start'] !== '2026-10-26T15:00' });
    expect(props()['start']).toBe('2026-10-26T15:00');
    expect(google.state.writes.filter((write) => write.kind === 'patch')).toEqual([]);
    expect(report.pulled).toBe(1);
  });

  it('stopped part way, it makes no more events and keeps no record', async () => {
    const { google, kept, sync } = setUp({ 'A block.md': blockFile(), 'B block.md': blockFile() });
    const report = await sync({ wanted: () => google.state.writes.length === 0 });
    expect(report.inserted).toBe(1);
    expect(google.state.writes.map((write) => write.kind)).toEqual(['insert']);
    expect(kept.has(VAULT)).toBe(false);
  });

  it('an insert retried after it landed (its version not written) patches the event, not a second one', async () => {
    const { vault, google, props, sync } = setUp();
    await sync();
    await sync();
    const withoutVersion = props();
    delete withoutVersion['gcal_etag'];
    vault.files.set(BLOCK, blockFile(withoutVersion));
    const report = await sync();
    expect(google.state.writes.map((write) => write.kind)).toEqual(['insert', 'insert', 'patch']);
    expect(google.state.events.size).toBe(1);
    expect(report.inserted).toBe(1);
    expect(props()['gcal_etag']).toBe('"g2"');
  });

  it('a note the index still calls a block, but whose file no longer is one, is never written to', async () => {
    const { vault, google, sync } = setUp(
      { 'Standup.md': file({ type: 'event', start: '2026-10-26T09:00', end: '2026-10-26T10:00' }) },
      { extraPaths: ['Standup.md'] },
    );
    const before = vault.files.get('Standup.md');
    await sync();
    expect(google.state.writes).toEqual([]);
    expect(vault.files.get('Standup.md')).toBe(before);
  });

  it('a block with no end is said once as not placed, and is not pushed', async () => {
    const { google, sync } = setUp({ [BLOCK]: blockFile({ end: '' }) });
    const report = await sync();
    expect(report.unplaced).toEqual([BLOCK]);
    expect(google.state.writes).toEqual([]);
    expect(blockSyncActivity(report).map((line) => line.message)).toEqual([
      '“Larkspur close block” is not on Google Calendar: it needs a start and an end time, the end after the start.',
    ]);
  });

  it('blocks more than two weeks past are history and stay off Google', async () => {
    const { google, sync } = setUp({
      [BLOCK]: blockFile({ start: '2026-10-01T09:00', end: '2026-10-01T10:00' }),
    });
    await sync();
    expect(google.state.writes).toEqual([]);
  });

  it('a note that is not a block, whatever the index says, is never written to', async () => {
    const { google, sync } = setUp({
      'Standup.md': file({ type: 'event', start: '2026-10-26T09:00', end: '2026-10-26T10:00' }),
    });
    await sync();
    expect(google.state.writes).toEqual([]);
  });

  it('a new calendar chosen starts again from a full listing and leaves the old calendar’s blocks alone', async () => {
    const { google, props, sync } = setUp();
    await sync();
    const report = await sync({ calendarId: 'other@group.calendar.example.com' });
    expect(google.state.asked.at(-1)).toEqual({
      calendarId: 'other@group.calendar.example.com',
      syncToken: null,
    });
    expect(report).toMatchObject({ inserted: 0, missing: 0 });
    expect(props()['gcal_calendar']).toBe(CALENDAR);
  });

  it('a copied block is made a block of its own, and the original keeps its event', async () => {
    const { google, props, sync, vault } = setUp();
    await sync();
    // A second sync hears its own insert, so the next listing does not name the event.
    await sync();
    const id = String(props()['gcal_event_id']);
    const copy = 'Mara Quill copy block.md';
    vault.files.set(
      copy,
      blockFile({ ...props(), start: '2026-10-27T09:00', end: '2026-10-27T10:00' }),
    );
    const report = await sync();
    expect(report.copies).toEqual([copy]);
    // The listing did not name the event: Google was asked which note it was written for.
    expect(google.state.fetched).toEqual([id]);
    const own = String(props(copy)['gcal_event_id']);
    expect(own).not.toBe(id);
    expect(google.state.writes.map((write) => [write.kind, write.call.eventId])).toEqual([
      ['insert', id],
      ['insert', own],
    ]);
    expect(props(copy)).toMatchObject({ gcal_synced_start: '2026-10-27T09:00', gcal_etag: '"g2"' });
    expect(props()).toMatchObject({ gcal_event_id: id, start: '2026-10-26T09:00' });
    expect(blockSyncActivity(report).find((line) => line.subject?.path === copy)).toMatchObject({
      level: 'info',
      message:
        '“Mara Quill copy block” is a copy of another block, so it was made a block of its own: the other keeps its Google event.',
    });
  });

  it('a copy dated before the sync looks back has its sync keys cleared and stays off Google', async () => {
    const { vault, google, props, sync } = setUp();
    await sync();
    const old = 'Archive/Larkspur close block.md';
    vault.files.set(
      old,
      blockFile({ ...props(), start: '2026-09-01T09:00', end: '2026-09-01T10:00' }),
    );
    const report = await sync();
    expect(report.copies).toEqual([old]);
    expect(props(old)).toEqual({
      type: 'block',
      start: '2026-09-01T09:00',
      end: '2026-09-01T10:00',
      tasks: ['[[Close the books]]'],
      owner: 'Mara Quill',
    });
    expect(vault.files.get(old)?.endsWith('\nBring the Q4 numbers.\n')).toBe(true);
    expect(google.state.writes).toHaveLength(1);
    expect(props()['gcal_event_id']).toBe(google.state.writes[0]?.call.eventId);
  });

  it('a new block whose drawn id another note carries takes the next one', async () => {
    const taken = drawn(0);
    const { google, props, sync } = setUp({
      [BLOCK]: blockFile(),
      // Renamed since its first push: it still carries the id drawn from this path.
      'Archive/Old close block.md': blockFile({
        start: '2026-09-01T09:00',
        end: '2026-09-01T10:00',
        gcal_event_id: taken,
        gcal_calendar: CALENDAR,
        gcal_etag: '"g0"',
      }),
    });
    await sync();
    const next = drawn(1);
    expect(props()['gcal_event_id']).toBe(next);
    expect(google.state.writes.map((write) => write.call.eventId)).toEqual([next]);
  });

  it('a new block whose id Google holds as deleted is given the next id, never left unsynced', async () => {
    const { google, props, sync } = setUp();
    const first = drawn(0);
    // A note at this path before had that event, since deleted in Google: its id stays taken.
    google.state.events.set(first, {
      id: first,
      etag: '"g0"',
      cancelled: true,
      title: '',
      start: null,
      end: null,
    });
    const report = await sync();
    const next = drawn(1);
    expect(report).toMatchObject({ inserted: 1, failed: [] });
    expect(props()['gcal_event_id']).toBe(next);
    expect(google.state.writes.map((write) => [write.kind, write.call.eventId])).toEqual([
      ['insert', first],
      ['patch', first],
      ['insert', next],
    ]);
  });

  it('gives up on a block after every id it may have is taken in Google, and says so', async () => {
    const { google, props, sync } = setUp();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = drawn(attempt);
      google.state.events.set(id, {
        id,
        etag: '"g0"',
        cancelled: true,
        title: '',
        start: null,
        end: null,
      });
    }
    const report = await sync();
    expect(report.failed.map((failure) => failure.path)).toEqual([BLOCK]);
    expect(props()['gcal_etag']).toBeUndefined();
  });
});

describe('syncBlocks: the vault’s own id, a seed of every new block’s event id', () => {
  const settingsProps = (vault: ReturnType<typeof setUp>['vault']) =>
    JSON.parse(vault.files.get(SETTINGS)?.split('\n')[1] ?? '{}') as Record<string, unknown>;

  it('a vault without one draws a new block’s id from the calendar alone, and the sync writes no id', async () => {
    // An id only this Mac had would make another writer draw another id for the same note.
    const { vault, google, sync } = setUp(
      { [BLOCK]: blockFile() },
      {
        // The zone kept already: the sync has nothing to write into the settings (#587).
        settings: file(
          { google_blocks: true, google_plan_zone: 'America/Los_Angeles' },
          '# Settings\n\nWords James wrote.\n',
        ),
      },
    );
    const before = vault.files.get(SETTINGS);
    await sync();
    expect(vault.files.get(SETTINGS)).toBe(before);
    expect(settingsProps(vault)).not.toHaveProperty('vault_id');
    expect(google.state.writes[0]?.call.eventId).toBe(
      blockEventId({ vaultId: null, calendarId: CALENDAR, path: BLOCK, attempt: 0 }),
    );
  });

  it('a vault with no settings file draws from the calendar alone, and no file is made', async () => {
    const { vault, google, sync } = setUp({ [BLOCK]: blockFile() }, { settings: null });
    // No zone to keep either (#587), so nothing else makes the file.
    google.state.primaryZone = null;
    await sync();
    expect(vault.files.has(SETTINGS)).toBe(false);
    expect(google.state.writes[0]?.call.eventId).toBe(
      blockEventId({ vaultId: null, calendarId: CALENDAR, path: BLOCK, attempt: 0 }),
    );
  });

  it('two vaults on one calendar draw two ids for one path, so neither patches the other’s event', async () => {
    const one = setUp();
    const two = setUp(undefined, { settings: file({ vault_id: 'p8r2s6u0c4f1g9j7' }) });
    await one.sync();
    await two.sync();
    const [first] = one.google.state.writes;
    const [second] = two.google.state.writes;
    expect(first?.call.eventId).toBe(drawn(0));
    expect(second?.call.eventId).not.toBe(first?.call.eventId);
  });

  it('a block pushed before keeps the id on its note, however ids are drawn now', async () => {
    const old = 'dfai0123456789abcdef0123456789abcdef';
    const { vault, google, props, sync } = setUp(
      {
        [BLOCK]: blockFile({
          gcal_event_id: old,
          gcal_calendar: CALENDAR,
          gcal_etag: '"g0"',
          gcal_synced_title: 'Larkspur close block',
          gcal_synced_start: '2026-10-26T09:00',
          gcal_synced_end: '2026-10-26T10:00',
        }),
      },
      { settings: null },
    );
    google.state.events.set(old, {
      id: old,
      etag: '"g0"',
      cancelled: false,
      title: 'Larkspur close block',
      start: { kind: 'timed', at: Date.parse('2026-10-26T09:00:00-07:00') },
      end: { kind: 'timed', at: Date.parse('2026-10-26T10:00:00-07:00') },
    });
    vault.files.set(
      BLOCK,
      blockFile({ ...props(), start: '2026-10-26T11:00', end: '2026-10-26T12:00' }),
    );
    const report = await sync();
    expect(report).toMatchObject({ pushed: 1, inserted: 0, failed: [] });
    expect(google.state.writes.map((write) => [write.kind, write.call.eventId])).toEqual([
      ['patch', old],
    ]);
    expect(props()['gcal_event_id']).toBe(old);
    // Nothing new to draw an id for, so no id is written; only the zone is kept (#587).
    expect(settingsProps(vault)).toEqual({ google_plan_zone: 'America/Los_Angeles' });
  });

  it('a vault id that is not text is never overwritten: the new block is not pushed, and says why', async () => {
    // The zone kept already, so nothing else writes the file (#587).
    const { vault, google, sync } = setUp(undefined, {
      settings: file({ vault_id: 42, google_plan_zone: 'America/Los_Angeles' }),
    });
    const before = vault.files.get(SETTINGS);
    const report = await sync();
    expect(google.state.writes).toEqual([]);
    expect(vault.files.get(SETTINGS)).toBe(before);
    expect(report.failed.map((failure) => failure.path)).toEqual([BLOCK]);
    expect(report.failed[0]?.problem.problem).toContain('vault_id');
  });
});

describe('syncBlocks: the plan zone kept in the vault’s settings (#587)', () => {
  const settingsProps = (vault: ReturnType<typeof setUp>['vault']) =>
    JSON.parse(vault.files.get(SETTINGS)?.split('\n')[1] ?? '{}') as Record<string, unknown>;

  it('keeps the primary calendar’s zone, not the Mac’s, where the vault reads no meetings', async () => {
    const { vault, sync } = setUp();
    await sync();
    expect(settingsProps(vault)).toMatchObject({ google_plan_zone: 'America/Los_Angeles' });
  });

  it('writes the settings once, not on every sync', async () => {
    const { vault, sync } = setUp();
    await sync();
    const kept = vault.files.get(SETTINGS);
    await sync();
    expect(vault.files.get(SETTINGS)).toBe(kept);
  });

  it('leaves the zone to the meetings sync in a vault that reads meetings', async () => {
    const settings = file({ vault_id: VAULT_ID, google_meetings: true });
    const { vault, sync } = setUp(undefined, { settings });
    await sync();
    expect(settingsProps(vault)).not.toHaveProperty('google_plan_zone');
  });

  it('keeps nothing when Google names no zone for the primary calendar', async () => {
    const { vault, google, sync } = setUp();
    google.state.primaryZone = null;
    await sync();
    expect(settingsProps(vault)).not.toHaveProperty('google_plan_zone');
  });

  it('still syncs when the settings refuse the zone', async () => {
    const { vault, sync } = setUp(undefined, { settings: '---\n: [unclosed\n---\n' });
    const report = await sync();
    expect(report.problem).toBeNull();
    expect(vault.files.get(SETTINGS)).toBe('---\n: [unclosed\n---\n');
  });

  it('says why the zone was not kept, and then that nothing is wrong once it is', async () => {
    const { vault, sync } = setUp(undefined, { settings: '---\n: [unclosed\n---\n' });
    const refused = await sync();
    expect(refused.zoneProblem).toContain("settings.md can't be read");
    // One line for it; the block the unreadable vault id held back says its own.
    expect(blockSyncActivity(refused)).toContainEqual(
      expect.objectContaining({
        level: 'warning',
        message: expect.stringContaining(
          'Blocks synced with Google Calendar, but the calendar’s time zone could not be kept',
        ),
      }),
    );
    vault.files.set(SETTINGS, file({ vault_id: VAULT_ID }));
    const kept = await sync();
    expect(kept.zoneProblem).toBeNull();
    expect(blockSyncActivity(kept).some((line) => line.level === 'warning')).toBe(false);
    expect(settingsProps(vault)).toMatchObject({ google_plan_zone: 'America/Los_Angeles' });
  });

  it('lets a fault in DFAI’s own code stop the sync, not pass as a refused write', async () => {
    const { vault, sync } = setUp();
    const reads = vault.ports.fs.readNotes.bind(vault.ports.fs);
    vault.ports.fs.readNotes = async (paths) => {
      if (paths.includes(SETTINGS)) throw new TypeError('settings is not iterable');
      return reads(paths);
    };
    const report = await sync();
    expect(report.problem?.problem).toContain('settings is not iterable');
    expect(report.zoneProblem).toBeNull();
  });
});

describe('syncBlocks: the zone blocks are shown on changed', () => {
  it('says so once, in Activity, with how far their times moved on this Mac', async () => {
    const { google, kept, sync } = setUp();
    const first = await sync();
    expect(first.zoneChange).toBeNull();
    expect(kept.get(VAULT)?.timeZone).toBe('America/Los_Angeles');
    // The person's primary calendar moved to New York: blocks are read on its zone now.
    google.state.primaryZone = 'America/New_York';
    const moved = await sync();
    expect(moved.zoneChange).toEqual({
      from: 'America/Los_Angeles',
      to: 'America/New_York',
      shiftMinutes: 180,
    });
    expect(blockSyncActivity(moved).map((line) => line.message)).toContain(
      'Blocks are now shown on America/New_York, so their times on this Mac moved by +3 h.',
    );
    expect(kept.get(VAULT)?.timeZone).toBe('America/New_York');
    const after = await sync();
    expect(after.zoneChange).toBeNull();
  });

  it.each([
    [-30, 'moved by −30 min'],
    [330, 'moved by +5 h 30 min'],
    [-480, 'moved by −8 h'],
    [0, 'did not move'],
  ])('says a shift of %i minutes as “%s”', async (shiftMinutes, said) => {
    const { sync } = setUp();
    const report = { ...(await sync()), zoneChange: { from: 'A/B', to: 'C/D', shiftMinutes } };
    const line = blockSyncActivity(report).find((each) => each.message.includes('C/D'));
    expect(line).toMatchObject({ level: 'info', subject: null });
    expect(line?.message).toBe(`Blocks are now shown on C/D, so their times on this Mac ${said}.`);
  });

  it('a Mac with no zone recorded says nothing: there is nothing to have moved from', async () => {
    const { kept, sync } = setUp();
    kept.set(VAULT, { calendarId: CALENDAR, syncToken: null, lastSyncAt: null, timeZone: null });
    expect((await sync()).zoneChange).toBeNull();
  });
});
