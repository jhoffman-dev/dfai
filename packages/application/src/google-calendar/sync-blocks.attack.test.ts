/**
 * Adversarial tests for two-way block sync (#30, PR #580). Fictional data
 * only; Google is the in-memory fake. Each test names the invariant it holds.
 */
import { describe, expect, it } from 'vitest';
import { createSettingsWriter } from '../settings/settings-writer.ts';
import { createVaultPath, splitFrontmatter, type BlockEvent } from '@dfai/domain';
import { automationVault, sqliteIndexPort } from '@dfai/application/testing/sqlite';
import type { IndexPort } from '../index/ports.ts';
import { toIndexedNote } from '../index/to-indexed-note.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { fakeBlockCalendar, memoryBlockSyncRecords } from '../testing/fake-google-calendar.ts';
import { blockSyncActivity } from './block-sync-activity.ts';
import { GoogleCalendarError } from './ports.ts';
import { syncBlocks, type BlockSyncRun } from './sync-blocks.ts';

const VAULT = '/Users/someone/Vault';
const CALENDAR = 'dfai-blocks@group.calendar.example.com';
const TODAY = '2026-10-25';
const NOW = Date.parse('2026-10-25T16:00:00Z');

const file = (properties: Record<string, unknown>, body: string) =>
  `---\n${JSON.stringify(properties)}\n---\n${body}`;

const blockFile = (start: string, end: string, more: Record<string, unknown> = {}, body = '') =>
  file({ type: 'block', start, end, owner: 'Mara Quill', ...more }, body);

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

/** mulberry32: a seeded RNG, so every sequence below replays exactly. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One Mac: its own vault files, its own record, its own RNG; Google may be shared. */
function mac(
  notes: Record<string, string>,
  google: ReturnType<typeof fakeBlockCalendar>,
  rngSeed = 1,
) {
  const vault = automationVault({ today: TODAY, notes });
  const { records, kept } = memoryBlockSyncRecords();
  const random = seeded(rngSeed);
  const ports = {
    calendar: google.calendar,
    records,
    fs: vault.ports.fs,
    markdown: vault.ports.markdown,
    index: liveIndex(vault.files, vault.ports.markdown),
    clock: { today: () => TODAY, now: () => NOW },
    settings: createSettingsWriter({ fs: vault.ports.fs, markdown: vault.ports.markdown }),
    rng: { next: random },
  };
  const run: BlockSyncRun = { vault: VAULT, calendarId: CALENDAR, timeZone: 'America/Los_Angeles' };
  const props = (path: string) =>
    JSON.parse(vault.files.get(path)?.split('\n')[1] ?? '{}') as Record<string, unknown>;
  const edit = (path: string, changes: Record<string, unknown>) => {
    const text = vault.files.get(path) ?? '';
    const { body } = splitFrontmatter(text);
    vault.files.set(path, file({ ...props(path), ...changes }, body));
  };
  return {
    vault,
    kept,
    props,
    edit,
    sync: (overrides: Partial<BlockSyncRun> = {}) => syncBlocks(ports, { ...run, ...overrides }),
  };
}

/** Someone renames the event in Google Calendar: a new version, times as they were. */
function renameEvent(google: ReturnType<typeof fakeBlockCalendar>, id: string, title: string) {
  const kept = google.state.events.get(id);
  if (kept === undefined) throw new Error(`no event ${id}`);
  google.state.versions += 1;
  google.state.events.set(id, { ...kept, title, etag: `"g${google.state.versions}"` });
  google.state.changed.add(id);
}

/** Someone changes something DFAI does not sync (a description, a colour): only the version moves. */
function touchEvent(google: ReturnType<typeof fakeBlockCalendar>, id: string) {
  renameEvent(google, id, google.state.events.get(id)?.title ?? '');
}

const wall = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00`;

describe('block sync, adversarial: random edits on both sides with syncs between', () => {
  // The keys block sync owns; the agreed record (gcal_synced_*) joined them in the fix round (decision 2).
  const OWNED = new Set([
    'gcal_event_id',
    'gcal_etag',
    'gcal_calendar',
    'gcal_missing',
    'gcal_synced_title',
    'gcal_synced_start',
    'gcal_synced_end',
    'gcal_pending',
  ]);
  const DAYS = ['2026-10-26', '2026-10-27', '2026-10-28'];

  /** Every non-owned key but start/end, and the body, as James last wrote them. */
  interface Expected {
    others: Record<string, unknown>;
    body: string;
  }

  function othersOf(properties: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(properties).filter(
        ([key]) => !OWNED.has(key) && key !== 'start' && key !== 'end',
      ),
    );
  }

  async function runSequence(seed: number, steps: number) {
    const random = seeded(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const google = fakeBlockCalendar();
    const notes: Record<string, string> = {};
    const expected = new Map<string, Expected>();
    for (let at = 0; at < 3; at += 1) {
      const path = `Blocks/Focus ${at} block.md`;
      const body = `Plan for ${at} — ünïcode ✓\n`;
      notes[path] = blockFile(wall(DAYS[at]!, 9 + at), wall(DAYS[at]!, 10 + at), {}, body);
      expected.set(path, { others: { type: 'block', owner: 'Mara Quill' }, body });
    }
    const here = mac(notes, google, seed);
    const log: string[] = [];
    const violations: string[] = [];
    const deletedInGoogle = new Set<string>();
    const touched = { dfai: new Set<string>(), google: new Set<string>() };

    const idOf = (path: string) => {
      const id = here.props(path)['gcal_event_id'];
      return typeof id === 'string' ? id : null;
    };
    const check = (label: string) => {
      for (const [path, want] of expected) {
        const text = here.vault.files.get(path);
        if (text === undefined) {
          violations.push(`${label}: ${path} was deleted or renamed by the sync`);
          continue;
        }
        if (splitFrontmatter(text).body !== want.body) violations.push(`${label}: body of ${path}`);
        const others = othersOf(here.props(path));
        if (JSON.stringify(others) !== JSON.stringify(want.others)) {
          violations.push(`${label}: keys of ${path}: ${JSON.stringify(others)}`);
        }
      }
      const ids = [...here.vault.files.keys()].map(idOf).filter((id) => id !== null);
      const inserts = google.state.writes.filter((write) => write.kind === 'insert');
      const madeIds = new Set(inserts.map((write) => write.call.eventId));
      if (madeIds.size > new Set(ids).size + deletedNotes.size) {
        violations.push(`${label}: ${madeIds.size} events made for ${ids.length} blocks`);
      }
      // Agreed: each live block and its event hold one title and one time.
      for (const path of expected.keys()) {
        const id = idOf(path);
        const event = id === null ? undefined : google.state.events.get(id);
        if (event === undefined || event.cancelled || here.props(path)['gcal_missing'] === true)
          continue;
        const name = path.slice('Blocks/'.length, -'.md'.length);
        const startAt = Date.parse(`${String(here.props(path)['start'])}:00-07:00`);
        if (event.title !== name)
          violations.push(`${label}: event of ${path} is titled "${event.title}"`);
        if (event.start?.kind === 'timed' && event.start.at !== startAt) {
          violations.push(`${label}: event of ${path} is at another time than the block`);
        }
      }
      for (const write of google.state.writes) {
        if (write.call.calendarId !== CALENDAR)
          violations.push(`${label}: wrote to another calendar`);
      }
    };
    const deletedNotes = new Set<string>();

    const sync = async (label: string) => {
      const before = google.state.writes.length;
      // Both sides changed and now disagree: Google's time must win, and be said.
      const disagreeing = new Map<string, unknown>();
      for (const path of touched.dfai) {
        const id = idOf(path);
        const event = id === null ? undefined : google.state.events.get(id);
        if (!touched.google.has(path) || event === undefined || event.cancelled) continue;
        const startAt = Date.parse(`${String(here.props(path)['start'])}:00-07:00`);
        if (event.start?.kind === 'timed' && event.start.at !== startAt)
          disagreeing.set(path, event.start);
      }
      const jamesOnly = new Map<string, string>();
      for (const path of touched.dfai) {
        const id = idOf(path);
        if (touched.google.has(path) || id === null || deletedInGoogle.has(id)) continue;
        jamesOnly.set(
          path,
          `${String(here.props(path)['start'])}–${String(here.props(path)['end'])}`,
        );
      }
      const report = await here.sync();
      // Only James moved it: his times stand, whatever else Google changed.
      for (const [path, times] of jamesOnly) {
        const now = `${String(here.props(path)['start'])}–${String(here.props(path)['end'])}`;
        if (expected.has(path) && now !== times) {
          violations.push(`${label}: James's move of ${path} (${times}) undone to ${now}`);
        }
      }
      if (report.problem !== null) violations.push(`${label}: problem ${report.problem.problem}`);
      // Both changed → Google wins, with an Activity line naming that block.
      for (const path of touched.dfai) {
        if (!disagreeing.has(path) || !expected.has(path)) continue;
        if (!report.conflicts.includes(path)) {
          violations.push(`${label}: both changed ${path}, no conflict reported`);
        }
        const lines = blockSyncActivity(report).filter((line) => line.subject?.path === path);
        if (lines.length === 0) violations.push(`${label}: no Activity line for ${path}`);
      }
      touched.dfai.clear();
      touched.google.clear();
      // A missing block is never pushed again.
      for (const write of google.state.writes.slice(before)) {
        if (deletedInGoogle.has(write.call.eventId)) {
          violations.push(`${label}: pushed ${write.call.eventId} after Google deleted it`);
        }
      }
      check(label);
      // Converged: a second sync with nothing changed writes nothing on either side.
      const writes = google.state.writes.length;
      const files = new Map(here.vault.files);
      await here.sync();
      if (google.state.writes.length !== writes) {
        violations.push(
          `${label}: second sync wrote to Google: ${JSON.stringify(google.state.writes.slice(writes).map((write) => [write.kind, write.call.fields]))}`,
        );
      }
      for (const [path, text] of here.vault.files) {
        if (files.get(path) !== text) violations.push(`${label}: second sync rewrote ${path}`);
      }
    };

    await sync('first');
    for (let step = 0; step < steps; step += 1) {
      const live = [...expected.keys()];
      if (live.length === 0) break;
      const path = pick(live);
      const id = idOf(path);
      const kind = pick([
        'moveBlock',
        'moveEvent',
        'duration',
        'deleteEvent',
        'deleteNote',
        'renameNote',
        'renameEvent',
        'touchEvent',
        'body',
        'jamesKey',
        'sync',
      ] as const);
      const day = pick(DAYS);
      const hour = 7 + Math.floor(random() * 10);
      log.push(`${step}: ${kind} ${path}`);
      const label = `seed ${seed} [${log.join('; ')}]`;
      switch (kind) {
        case 'moveBlock': {
          const before = here.vault.files.get(path);
          here.edit(path, { start: wall(day, hour), end: wall(day, hour + 1) });
          if (here.vault.files.get(path) !== before) touched.dfai.add(path);
          break;
        }
        case 'duration': {
          const start = String(here.props(path)['start']);
          if (!/T\d\d:\d\d$/.test(start)) break;
          const startHour = Number(start.slice(11, 13));
          const before = here.vault.files.get(path);
          here.edit(path, { end: wall(start.slice(0, 10), Math.min(23, startHour + 2)) });
          if (here.vault.files.get(path) !== before) touched.dfai.add(path);
          break;
        }
        case 'moveEvent': {
          if (id === null || deletedInGoogle.has(id) || !google.state.events.has(id)) break;
          const was = google.state.events.get(id)?.start;
          google.move(id, wall(day, hour), wall(day, hour + 1));
          if (JSON.stringify(google.state.events.get(id)?.start) !== JSON.stringify(was)) {
            touched.google.add(path);
          }
          break;
        }
        case 'deleteEvent':
          if (id === null || !google.state.events.has(id)) break;
          google.remove(id);
          deletedInGoogle.add(id);
          break;
        case 'deleteNote':
          await here.vault.ports.fs.trashEntry({ path: createVaultPath(path) });
          expected.delete(path);
          deletedNotes.add(path);
          break;
        case 'renameNote': {
          const to = path.replace(' block.md', ' renamed block.md');
          if (to === path || here.vault.files.has(to)) break;
          await here.vault.ports.fs.moveEntry({
            from: createVaultPath(path),
            to: createVaultPath(to),
          });
          expected.set(to, expected.get(path)!);
          expected.delete(path);
          for (const side of [touched.dfai, touched.google]) {
            if (side.delete(path)) side.add(to);
          }
          break;
        }
        case 'renameEvent':
          if (id === null || deletedInGoogle.has(id) || !google.state.events.has(id)) break;
          renameEvent(google, id, `Renamed in Google ${step}`);
          break;
        case 'touchEvent':
          if (id === null || deletedInGoogle.has(id) || !google.state.events.has(id)) break;
          touchEvent(google, id);
          break;
        case 'body': {
          const want = expected.get(path)!;
          want.body = `${want.body}Edited at step ${step}.\n`;
          const { frontmatter } = splitFrontmatter(here.vault.files.get(path) ?? '');
          here.vault.files.set(path, `${frontmatter}${want.body}`);
          break;
        }
        case 'jamesKey': {
          const want = expected.get(path)!;
          want.others = { ...want.others, note: `step ${step}` };
          here.edit(path, { note: `step ${step}` });
          break;
        }
        case 'sync':
          await sync(label);
          break;
      }
    }
    await sync(`seed ${seed} end [${log.join('; ')}]`);
    return violations;
  }

  it('keeps every invariant over 150 seeded sequences of 20 steps', async () => {
    const violations: string[] = [];
    for (let seed = 1; seed <= 150 && violations.length === 0; seed += 1) {
      violations.push(...(await runSequence(seed, 20)));
    }
    expect(violations.slice(0, 3)).toEqual([]);
  }, 120_000);
});

describe('block sync, adversarial: a change in Google that is not a time', () => {
  it('a description or colour edited in Google does not undo a block James moved', async () => {
    const google = fakeBlockCalendar();
    const path = 'Blocks/Quarter close block.md';
    const here = mac({ [path]: blockFile('2026-10-26T09:00', '2026-10-26T10:00') }, google);
    await here.sync();
    const id = String(here.props(path)['gcal_event_id']);
    // James moves the block in DFAI; in Google only the event's description changes.
    here.edit(path, { start: '2026-10-26T14:00', end: '2026-10-26T15:00' });
    touchEvent(google, id);
    const report = await here.sync();
    expect(here.props(path)).toMatchObject({ start: '2026-10-26T14:00', end: '2026-10-26T15:00' });
    expect(report.conflicts).toEqual([]);
  });

  it('a block whose own etag write failed after its patch landed is not rolled back to the pushed time', async () => {
    const google = fakeBlockCalendar();
    const path = 'Blocks/Quarter close block.md';
    const here = mac({ [path]: blockFile('2026-10-26T09:00', '2026-10-26T10:00') }, google);
    await here.sync();
    here.edit(path, { start: '2026-10-26T11:00', end: '2026-10-26T12:00' });
    // The patch lands; then James saves the block again before its version is written back.
    const realPatch = google.calendar.patchBlockEvent;
    google.calendar.patchBlockEvent = async (call) => {
      const written = await realPatch(call);
      here.edit(path, { start: '2026-10-26T16:00', end: '2026-10-26T17:00' });
      await here.vault.ports.fs.writeTextFile({
        path: createVaultPath(path),
        contents: here.vault.files.get(path) ?? '',
        expectedModified: null,
      });
      return written;
    };
    const first = await here.sync();
    google.calendar.patchBlockEvent = realPatch;
    expect(first.failed.map((failure) => failure.path)).toEqual([path]);
    await here.sync();
    // James's newest edit (16:00) is what both sides should end on.
    expect(here.props(path)).toMatchObject({ start: '2026-10-26T16:00', end: '2026-10-26T17:00' });
  });
});

describe('block sync, adversarial: a retried push is based on the version it was planned against', () => {
  const offline = () => new GoogleCalendarError({ kind: 'unreachable', message: 'offline' });

  it('a colour changed in Google, then James’s move fails to send: the retry sends it, no conflict', async () => {
    const google = fakeBlockCalendar();
    const path = 'Blocks/Payroll run block.md';
    const here = mac({ [path]: blockFile('2026-10-26T09:00', '2026-10-26T10:00') }, google);
    await here.sync();
    const id = String(here.props(path)['gcal_event_id']);
    touchEvent(google, id);
    here.edit(path, { start: '2026-10-26T10:00', end: '2026-10-26T11:00' });
    google.state.failNext.patch = offline();
    expect((await here.sync()).failed.map((failure) => failure.path)).toEqual([path]);
    // A full listing (a lost token) gives the coloured version, still on 09:00.
    google.expire();
    const report = await here.sync();
    expect(report.conflicts).toEqual([]);
    expect(here.props(path)).toMatchObject({ start: '2026-10-26T10:00', end: '2026-10-26T11:00' });
    expect(google.state.events.get(id)?.start).toEqual({
      kind: 'timed',
      at: Date.parse('2026-10-26T10:00:00-07:00'),
    });
  });

  it('2(c) twice: a push landed with its version unwritten, then the push of James’s newer edit fails too', async () => {
    const google = fakeBlockCalendar();
    const path = 'Blocks/Quarter close block.md';
    const here = mac({ [path]: blockFile('2026-10-26T09:00', '2026-10-26T10:00') }, google);
    await here.sync();
    const id = String(here.props(path)['gcal_event_id']);
    here.edit(path, { start: '2026-10-26T10:00', end: '2026-10-26T11:00' });
    const realPatch = google.calendar.patchBlockEvent;
    google.calendar.patchBlockEvent = async (call) => {
      const written = await realPatch(call);
      // James saves 11:00 before the version of the landed push is written back.
      here.edit(path, { start: '2026-10-26T11:00', end: '2026-10-26T12:00' });
      await here.vault.ports.fs.writeTextFile({
        path: createVaultPath(path),
        contents: here.vault.files.get(path) ?? '',
        expectedModified: null,
      });
      return written;
    };
    expect((await here.sync()).failed.map((failure) => failure.path)).toEqual([path]);
    google.calendar.patchBlockEvent = realPatch;
    google.state.failNext.patch = offline();
    expect((await here.sync()).failed.map((failure) => failure.path)).toEqual([path]);
    google.expire();
    const report = await here.sync();
    expect(report.conflicts).toEqual([]);
    expect(here.props(path)).toMatchObject({ start: '2026-10-26T11:00', end: '2026-10-26T12:00' });
    expect(google.state.events.get(id)?.start).toEqual({
      kind: 'timed',
      at: Date.parse('2026-10-26T11:00:00-07:00'),
    });
  });
});

describe('block sync, adversarial: copied blocks (one gcal_event_id on two notes)', () => {
  it('a Finder copy ("… copy.md") moved to another day does not take the original block’s event', async () => {
    const google = fakeBlockCalendar();
    const original = 'Blocks/Ledger review block.md';
    const here = mac({ [original]: blockFile('2026-10-26T09:00', '2026-10-26T10:00') }, google);
    await here.sync();
    const id = String(here.props(original)['gcal_event_id']);
    // Finder names a copy "<name> copy.md"; ' ' sorts before '.', so the copy comes first by path.
    const copy = 'Blocks/Ledger review block copy.md';
    here.vault.files.set(copy, here.vault.files.get(original) ?? '');
    here.edit(copy, { start: '2026-10-28T13:00', end: '2026-10-28T14:00' });
    await here.sync();
    const event = google.state.events.get(id);
    expect(event?.start).toEqual({ kind: 'timed', at: Date.parse('2026-10-26T09:00:00-07:00') });
  });

  it('copying an old block into this week never rewrites the old block’s times', async () => {
    // A month ago the block synced; it is now past the two-week window.
    const id = 'dfaiold0000000000000000000000';
    const google = fakeBlockCalendar([
      {
        id,
        etag: '"g0"',
        cancelled: false,
        title: 'Deep work block',
        start: { kind: 'timed', at: Date.parse('2026-09-01T09:00:00-07:00') },
        end: { kind: 'timed', at: Date.parse('2026-09-01T10:00:00-07:00') },
      },
    ]);
    const original = 'Archive/Deep work block.md';
    const owned = { gcal_event_id: id, gcal_etag: '"g0"', gcal_calendar: CALENDAR };
    const here = mac(
      { [original]: blockFile('2026-09-01T09:00', '2026-09-01T10:00', owned) },
      google,
    );
    const first = await here.sync();
    expect(first).toMatchObject({ inserted: 0, pushed: 0, pulled: 0, failed: [] });
    // James copies it into this week's folder and sets the new day.
    const copy = 'Blocks/Deep work block.md';
    here.vault.files.set(copy, here.vault.files.get(original) ?? '');
    here.edit(copy, { start: '2026-10-27T09:00', end: '2026-10-27T10:00' });
    await here.sync();
    await here.sync();
    expect(here.props(original)).toMatchObject({
      start: '2026-09-01T09:00',
      end: '2026-09-01T10:00',
    });
  });
});

describe('block sync, adversarial: titles go one way', () => {
  it('an event renamed and moved in Google gets the block’s name back', async () => {
    const google = fakeBlockCalendar();
    const path = 'Blocks/Ledger review block.md';
    const here = mac({ [path]: blockFile('2026-10-26T09:00', '2026-10-26T10:00') }, google);
    await here.sync();
    const id = String(here.props(path)['gcal_event_id']);
    renameEvent(google, id, 'Lunch with Tobias Fenn');
    google.move(id, '2026-10-26T12:00', '2026-10-26T13:00');
    await here.sync();
    await here.sync();
    await here.sync();
    expect(here.props(path)).toMatchObject({ start: '2026-10-26T12:00' });
    expect(google.state.events.get(id)?.title).toBe('Ledger review block');
  });
});

describe('block sync, adversarial: two Macs', () => {
  it('two Macs that both think they are the writer for one tick (git lag) make one event for one block', async () => {
    const google = fakeBlockCalendar();
    const path = 'Blocks/Payroll run block.md';
    const notes = {
      // Turning the switch on gave the vault its id, and git carried both to each Mac.
      '.atlas/settings.md': file({ google_blocks: true, vault_id: 'k3v9q0m2b7hd5t1e' }, ''),
      [path]: blockFile('2026-10-26T09:00', '2026-10-26T10:00'),
    };
    const macA = mac(notes, google, 11);
    const macB = mac(notes, google, 22);
    await macA.sync();
    // Mac B has not pulled Mac A's write of gcal_event_id yet.
    await macB.sync();
    const inserted = new Set(
      google.state.writes.filter((write) => write.kind === 'insert').map((w) => w.call.eventId),
    );
    expect(inserted.size).toBe(1);
  });

  it('two writers for one tick in a vault with no vault_id yet make one event for one block', async () => {
    const google = fakeBlockCalendar();
    const path = 'Blocks/Payroll run block.md';
    // Switched on by an earlier build, or the id lost in a settings conflict.
    const notes = {
      '.atlas/settings.md': file({ google_blocks: true }, ''),
      [path]: blockFile('2026-10-26T09:00', '2026-10-26T10:00'),
    };
    const macA = mac(notes, google, 11);
    const macB = mac(notes, google, 22);
    await macA.sync();
    await macB.sync();
    const inserted = new Set(
      google.state.writes.filter((write) => write.kind === 'insert').map((w) => w.call.eventId),
    );
    expect(inserted.size).toBe(1);
    expect(google.state.events.size).toBe(1);
  });

  it('a new automations Mac (no record) says so when Google and James both moved a block', async () => {
    const google = fakeBlockCalendar();
    const path = 'Blocks/Payroll run block.md';
    const old = mac({ [path]: blockFile('2026-10-26T09:00', '2026-10-26T10:00') }, google);
    await old.sync();
    const id = String(old.props(path)['gcal_event_id']);
    // Handover: the new Mac has the vault (via git) but no localStorage record.
    const fresh = mac(Object.fromEntries(old.vault.files), google);
    fresh.edit(path, { start: '2026-10-26T13:00', end: '2026-10-26T14:00' });
    google.move(id, '2026-10-26T15:00', '2026-10-26T16:00');
    const report = await fresh.sync();
    expect(report.conflicts).toEqual([path]);
  });
});

describe('block sync, adversarial: zones', () => {
  it('a block at 09:00 on the Mac lands at 09:00 on the Mac when the blocks calendar is on UTC', async () => {
    const google = fakeBlockCalendar([], 'Z');
    // A calendar made through the API without a timeZone is on UTC.
    google.state.zone = 'UTC';
    const path = 'Blocks/Standup prep block.md';
    const here = mac({ [path]: blockFile('2026-10-26T09:00', '2026-10-26T10:00') }, google);
    await here.sync({ timeZone: 'America/Los_Angeles' });
    const [write] = google.state.writes;
    // The vault's wall clock is the Mac's (and the primary calendar's) — not the blocks calendar's.
    expect(write?.call.timeZone).toBe('America/Los_Angeles');
  });
});

describe('block sync, adversarial: hostile events', () => {
  it('an event Google lists with no etag does not make every sync rewrite the block', async () => {
    const google = fakeBlockCalendar();
    const path = 'Blocks/Ledger review block.md';
    const here = mac({ [path]: blockFile('2026-10-26T09:00', '2026-10-26T10:00') }, google);
    await here.sync();
    const id = String(here.props(path)['gcal_event_id']);
    const kept = google.state.events.get(id) as BlockEvent;
    google.state.events.set(id, { ...kept, etag: null });
    // Every listing in full, as when Google hands out no sync token.
    google.expire();
    await here.sync();
    const writes = here.vault.log.filter((line) => line.startsWith('write')).length;
    google.expire();
    await here.sync();
    google.expire();
    await here.sync();
    expect(here.vault.log.filter((line) => line.startsWith('write'))).toHaveLength(writes);
  });
});

describe('block sync, adversarial: Stop', () => {
  it('Stop pressed while a new block’s id is being written sends no insert after it', async () => {
    const google = fakeBlockCalendar();
    const path = 'Blocks/Ledger review block.md';
    const here = mac({ [path]: blockFile('2026-10-26T09:00', '2026-10-26T10:00') }, google);
    let stopped = false;
    const write = here.vault.ports.fs.writeTextFile;
    here.vault.ports.fs.writeTextFile = async (request) => {
      const modified = await write(request);
      stopped = true;
      return modified;
    };
    await here.sync({ wanted: () => !stopped });
    expect(google.state.writes).toEqual([]);
  });
});
