import {
  addDays,
  blockEventId,
  blockOnDisk,
  blockPlanZone,
  blockZoneChange,
  compileBlocksByEventIdQuery,
  compileBlocksToSyncQuery,
  createVaultPath,
  isBlockType,
  isScopeRefusal,
  noteTitle,
  pushableFields,
  reconcileBlocks,
  splitFrontmatter,
  BLOCK_EVENT_ID_ATTEMPTS,
  BLOCK_KEYS,
  BLOCK_SYNC_DAYS_BEFORE,
  BLOCK_SYNC_KEYS,
  EVENT_ID_LOOKUP_SIZE,
  type BlockAction,
  type BlockEvent,
  type BlockOnDisk,
  type BlockSyncFields,
  type BlockZoneChange,
  type CompiledQuery,
  type GoogleProblem,
} from '@dfai/domain';
import type { IndexPort, QueryResult } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { Clock, Rng } from '../ports.ts';
import type { SettingsWriter } from '../settings/settings-writer.ts';
import { ensureVaultId } from '../settings/vault-id.ts';
import type { NoteFile, VaultFsPort } from '../vault/ports.ts';
import { googleProblemOf } from './google-calendar.ts';
import {
  GoogleCalendarError,
  type BlockCalendar,
  type BlockEventChanges,
  type BlockEventWrite,
  type BlockSyncRecord,
  type BlockSyncRecords,
} from './ports.ts';

/** A block that did not sync this time, and why. The others synced without it. */
export interface BlockFailure {
  readonly path: string;
  readonly problem: GoogleProblem;
}

/** What one block sync did, as Settings and Activity say it. */
export interface BlockSyncReport {
  readonly ran: number;
  /** Blocks whose event was made. */
  readonly inserted: number;
  /** Blocks DFAI changed whose event was changed to match. */
  readonly pushed: number;
  /** Blocks Google moved, whose times were written from it. */
  readonly pulled: number;
  /** Blocks marked because Google deleted their event. Never removed. */
  readonly missing: number;
  /** Blocks both sides changed, where Google's time was kept. */
  readonly conflicts: readonly string[];
  /** Blocks with no time at both ends, which have nothing to push. */
  readonly unplaced: readonly string[];
  /** Copies of another block (one event id on two notes), each made a new block of its own. */
  readonly copies: readonly string[];
  readonly failed: readonly BlockFailure[];
  /** Whether the calendar was listed in full rather than by what changed. */
  readonly full: boolean;
  /** The zone blocks are read on is not the one this Mac's last sync used; null when it is. */
  readonly zoneChange: BlockZoneChange | null;
  /** Why it stopped before writing anything; null when it ran. */
  readonly problem: GoogleProblem | null;
  /** Google said this sign-in may not change the calendar: the clock waits for the grant to change. */
  readonly scopeRefused: boolean;
}

export interface BlockSyncPorts {
  readonly calendar: BlockCalendar;
  readonly records: BlockSyncRecords;
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly index: Pick<IndexPort, 'query'>;
  readonly clock: Pick<Clock, 'today' | 'now'>;
  /** Draws the vault's own id, once, when its settings hold none and a new block needs an event id. */
  readonly rng: Pick<Rng, 'next'>;
  /** The vault's one way into its settings, where that id is written. */
  readonly settings: SettingsWriter;
}

export interface BlockSyncRun {
  readonly vault: string;
  /** The one calendar blocks go to (`google_calendar`). No other is ever written. */
  readonly calendarId: string;
  /** The Mac's zone: blocks are on it only when Google names no zone for the primary calendar. */
  readonly timeZone: string;
  /** Asked before each call to Google and each write; false once the person stops the sync. */
  readonly wanted?: () => boolean;
}

const ALWAYS_WANTED = () => true;

/**
 * The person stopped the sync between two of its writes: nothing more is
 * sent or written. `landed` is what Google had already taken of the block.
 */
class SyncStopped extends Error {
  readonly landed: Outcome;
  constructor(landed: Outcome = null) {
    super('the block sync was stopped');
    this.landed = landed;
  }
}

const refusedScope = (cause: unknown) =>
  cause instanceof GoogleCalendarError && isScopeRefusal(cause.failure);

const SCOPE_REFUSED: GoogleProblem = {
  problem: 'Blocks are not synced on this Mac: its Google sign-in may not change that calendar.',
  fix: 'In Settings → Google Calendar, choose the calendar DFAI made for blocks, or allow syncing blocks again.',
};

const problemOf = (cause: unknown) =>
  refusedScope(cause) ? SCOPE_REFUSED : googleProblemOf(cause);

type Listed = Extract<BlockEventChanges, { kind: 'changes' }> & { readonly full: boolean };

/** What changed since the token this Mac keeps, or every event when it has none or Google let it lapse (410). */
async function listCalendar(
  ports: BlockSyncPorts,
  run: BlockSyncRun & { readonly wanted: () => boolean },
  token: string | null,
) {
  const list = (syncToken: string | null) =>
    ports.calendar.listBlockEvents({ vault: run.vault, calendarId: run.calendarId, syncToken });
  const first = await list(token);
  if (first.kind === 'expired' && !run.wanted()) throw new SyncStopped();
  const answer = first.kind === 'expired' ? await list(null) : first;
  if (answer.kind === 'expired') throw new Error('Google asked for a full listing of blocks again');
  return { ...answer, full: token === null || first.kind === 'expired' } satisfies Listed;
}

const pathsIn = (result: QueryResult): string[] => {
  const column = result.columns.indexOf('path');
  return result.rows.map((row) => String(row[column]));
};

function idBatches(ids: Iterable<string>): string[][] {
  const unique = [...new Set(ids)];
  const batches: string[][] = [];
  for (let at = 0; at < unique.length; at += EVENT_ID_LOOKUP_SIZE) {
    batches.push(unique.slice(at, at + EVENT_ID_LOOKUP_SIZE));
  }
  return batches;
}

/** The paths a query finds over every batch of ids. */
async function pathsFor(
  ports: BlockSyncPorts,
  batches: readonly (readonly string[])[],
  compile: (ids: readonly string[]) => CompiledQuery,
): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const batch of batches) {
    const { sql, parameters } = compile(batch);
    for (const path of pathsIn(await ports.index.query(sql, parameters))) paths.add(path);
  }
  return paths;
}

/** The notes at `paths` that are blocks, as their files say now, not as the index last read them. */
async function blocksAt(ports: BlockSyncPorts, paths: readonly string[]) {
  const files = await ports.fs.readNotes(paths);
  const blocks: BlockOnDisk[] = [];
  for (const file of files) {
    const properties = ports.markdown.frontmatterProperties(
      splitFrontmatter(file.text).frontmatter,
    );
    const type = properties['type'];
    if (typeof type !== 'string' || !isBlockType(type)) continue;
    const title = noteTitle(createVaultPath(file.path));
    blocks.push(blockOnDisk({ path: file.path, title, properties }));
  }
  return { blocks, files };
}

/**
 * The blocks a sync may write to: those from two weeks ago on, any whose
 * event Google listed, and every other note, of any day, carrying one of
 * their event ids — so a copied note is seen beside the one it was copied
 * from, however old that is.
 */
async function readBlocks(ports: BlockSyncPorts, events: readonly BlockEvent[], fromDay: string) {
  const listed = idBatches(events.map((event) => event.id));
  // With no event listed, the window alone is asked for, once.
  const near = await pathsFor(ports, listed.length === 0 ? [[]] : listed, (ids) =>
    compileBlocksToSyncQuery({ ids, fromDay }),
  );
  const first = await blocksAt(ports, [...near]);
  const carried = first.blocks.flatMap((block) => (block.eventId === null ? [] : [block.eventId]));
  const sharing = await pathsFor(ports, idBatches(carried), (ids) =>
    compileBlocksByEventIdQuery({ ids }),
  );
  const more = await blocksAt(
    ports,
    [...sharing].filter((path) => !near.has(path)),
  );
  const files = [...first.files, ...more.files];
  return {
    blocks: [...first.blocks, ...more.blocks],
    files: new Map(files.map((file) => [file.path, file])),
  };
}

/**
 * Google's copy of each event two notes carry that the listing did not
 * give, so which note it was written for is known before either is touched.
 */
async function eventsOfCopies(
  ports: BlockSyncPorts,
  run: BlockSyncRun & { readonly wanted: () => boolean },
  { blocks, events }: { blocks: readonly BlockOnDisk[]; events: readonly BlockEvent[] },
): Promise<BlockEvent[]> {
  const listed = new Set(events.map((event) => event.id));
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const { eventId } of blocks) {
    if (eventId === null) continue;
    if (seen.has(eventId) && !listed.has(eventId)) shared.add(eventId);
    seen.add(eventId);
  }
  const fetched: BlockEvent[] = [];
  for (const eventId of shared) {
    if (!run.wanted()) throw new SyncStopped();
    const event = await ports.calendar.getBlockEvent({
      vault: run.vault,
      calendarId: run.calendarId,
      eventId,
    });
    if (event !== null) fetched.push(event);
  }
  return fetched;
}

interface Applying {
  readonly ports: BlockSyncPorts;
  readonly run: BlockSyncRun;
  /** The plan zone: what every block's wall clock means. */
  readonly timeZone: string;
  readonly files: Map<string, NoteFile>;
  readonly wanted: () => boolean;
  /** The vault's own id, read (or made) the first time a new block needs an event id. */
  readonly vaultId: () => Promise<string>;
}

/** `make` the first time it is asked for, and the same answer after; a failure is asked again next time. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | null = null;
  return () => {
    made ??= make().catch((cause: unknown) => {
      made = null;
      throw cause;
    });
    return made;
  };
}

/** Stops here when the person has stopped the sync. */
function goOn(applying: Applying): void {
  if (!applying.wanted()) throw new SyncStopped();
}

/** Writes the owned keys onto a block, every other byte of it as it was (ADR-0003). */
async function writeOwned(
  applying: Applying,
  path: string,
  changes: Readonly<Record<string, unknown>>,
): Promise<void> {
  const { ports, files } = applying;
  const file = files.get(path);
  // Every block written to is one this sync has just read.
  if (file === undefined) throw new Error(`${path} was not read before it was written`);
  const document = splitFrontmatter(file.text);
  const contents = ports.markdown.updateFrontmatter(document.frontmatter, changes) + document.body;
  if (contents === file.text) return;
  goOn(applying);
  const modified = await ports.fs.writeTextFile({
    path: createVaultPath(path),
    contents,
    expectedModified: file.modified,
  });
  files.set(path, { ...file, text: contents, modified });
}

/** The agreed record, as the keys it is written in. */
const syncedKeys = (fields: BlockSyncFields) => ({
  [BLOCK_SYNC_KEYS.syncedTitle]: fields.title,
  [BLOCK_SYNC_KEYS.syncedStart]: fields.start,
  [BLOCK_SYNC_KEYS.syncedEnd]: fields.end,
});

/** A version Google gave, as a change; none when it gave none, so the block's is not cleared. */
const etagKeys = (etag: string | null) => (etag === null ? {} : { [BLOCK_SYNC_KEYS.etag]: etag });

/** Google answered with a version: the push is no longer pending. Without one it stays pending, and is sent again. */
const answeredKeys = (etag: string | null) =>
  etag === null ? {} : { [BLOCK_SYNC_KEYS.etag]: etag, [BLOCK_SYNC_KEYS.pending]: null };

/** Writes the event, as an insert or a patch; an insert whose id is taken already landed once, and is patched. */
async function writeEvent(
  applying: Applying,
  {
    eventId,
    fields,
    insert,
    path,
  }: { eventId: string; fields: BlockSyncFields; insert: boolean; path: string },
): Promise<BlockEventWrite> {
  const { calendar } = applying.ports;
  const call = {
    vault: applying.run.vault,
    calendarId: applying.run.calendarId,
    eventId,
    fields,
    timeZone: applying.timeZone,
    notePath: path,
  };
  goOn(applying);
  const written = insert
    ? await calendar.insertBlockEvent(call)
    : await calendar.patchBlockEvent(call);
  if (written.kind !== 'exists') return written;
  goOn(applying);
  return calendar.patchBlockEvent(call);
}

/** The first id for a new block, from `attempt` on, that no other note carries. */
async function freeEventId(applying: Applying, path: string, attempt: number) {
  for (let at = attempt; at < BLOCK_EVENT_ID_ATTEMPTS; at += 1) {
    const eventId = blockEventId({
      vaultId: await applying.vaultId(),
      calendarId: applying.run.calendarId,
      path,
      attempt: at,
    });
    const carriers = await pathsFor(applying.ports, [[eventId]], (ids) =>
      compileBlocksByEventIdQuery({ ids }),
    );
    carriers.delete(path);
    if (carriers.size === 0) return { eventId, attempt: at };
  }
  throw new Error('no event id is free for this block');
}

/**
 * Gives a block a new event id, written onto it with the agreed record
 * before anything is sent, so a retry is the same event and a push that
 * lands is known for DFAI's own. A copy's version and mark are cleared.
 */
async function newIdentity(
  applying: Applying,
  { path, fields, attempt }: { path: string; fields: BlockSyncFields; attempt: number },
) {
  const fresh = await freeEventId(applying, path, attempt);
  await writeOwned(applying, path, {
    [BLOCK_SYNC_KEYS.eventId]: fresh.eventId,
    [BLOCK_SYNC_KEYS.calendar]: applying.run.calendarId,
    [BLOCK_SYNC_KEYS.etag]: null,
    [BLOCK_SYNC_KEYS.missing]: null,
    [BLOCK_SYNC_KEYS.pending]: true,
    ...syncedKeys(fields),
  });
  return fresh;
}

/** Makes a block's event under a new id, past any id Google holds as deleted. */
async function insertNew(
  applying: Applying,
  { path, fields }: { path: string; fields: BlockSyncFields },
) {
  let fresh = await newIdentity(applying, { path, fields, attempt: 0 });
  for (;;) {
    const written = await writeEvent(applying, {
      eventId: fresh.eventId,
      fields,
      insert: true,
      path,
    });
    if (written.kind === 'written') return written;
    // The id is one Google deleted (a note at this path before): the next one is tried.
    if (fresh.attempt + 1 >= BLOCK_EVENT_ID_ATTEMPTS) {
      throw new Error('Google would not make the block’s event');
    }
    fresh = await newIdentity(applying, { path, fields, attempt: fresh.attempt + 1 });
  }
}

type Outcome = 'inserted' | 'pushed' | 'pulled' | 'missing' | 'copied' | null;

/**
 * Pushes a block to its event. What is sent is written onto the block as
 * agreed, marked pending, before it is sent; its version is the one of the
 * listed event it was planned against (else the last one Google confirmed),
 * so Google listing that version again means nothing changed there. If the push lands and the write of its version after it
 * fails (James saved the block meanwhile), the next sync finds Google on the
 * agreed times, knows the push for DFAI's own, and pushes his newer edit. If
 * it never lands, Google still lists the version the block kept, so the next
 * sync sends it again; a listing of another version on other times is a
 * change on both sides, and Google's is kept and said — never taken silently.
 */
async function push(
  applying: Applying,
  action: Extract<BlockAction, { kind: 'insert' | 'patch' }>,
): Promise<Outcome> {
  const { path, fields, eventId } = action;
  const insert = action.kind === 'insert';
  if (eventId === null) {
    const written = await insertNew(applying, { path, fields });
    const copied = action.kind === 'insert' && action.copyOf !== null;
    return landed(applying, { path, etag: written.etag, outcome: copied ? 'copied' : 'inserted' });
  }
  // Pending until Google answers: a send that never lands is sent again, not taken as agreed.
  // Based on the version it was planned against, so a retry knows Google unchanged since.
  const basedOn = action.kind === 'patch' ? action.basedOn : null;
  await writeOwned(applying, path, {
    ...syncedKeys(fields),
    ...etagKeys(basedOn),
    [BLOCK_SYNC_KEYS.pending]: true,
  });
  const written = await writeEvent(applying, { eventId, fields, insert, path });
  if (written.kind !== 'written') {
    // Its event was made, then deleted in Google since: the block is marked, never removed.
    await writeOwned(applying, path, { [BLOCK_SYNC_KEYS.missing]: true });
    return 'missing';
  }
  return landed(applying, { path, etag: written.etag, outcome: insert ? 'inserted' : 'pushed' });
}

/**
 * Writes the version a push landed as. Stopped first, the push still counts:
 * the agreed record went on the block before it was sent, so the next sync
 * knows Google's times for DFAI's own without the version.
 */
async function landed(
  applying: Applying,
  { path, etag, outcome }: { path: string; etag: string | null; outcome: Outcome },
): Promise<Outcome> {
  if (!applying.wanted()) throw new SyncStopped(outcome);
  await writeOwned(applying, path, answeredKeys(etag));
  return outcome;
}

/** Writes Google's times onto the block, as agreed; then, when its title strayed, puts the block's back. */
async function pull(applying: Applying, action: Extract<BlockAction, { kind: 'pull' }>) {
  const { path, fields } = action;
  await writeOwned(applying, path, {
    [BLOCK_KEYS.start]: fields.start,
    [BLOCK_KEYS.end]: fields.end,
    ...syncedKeys(fields),
    ...etagKeys(action.etag),
    // Google's times are now the agreed ones: nothing DFAI sent is waited on any more.
    [BLOCK_SYNC_KEYS.pending]: null,
    ...(action.returned ? { [BLOCK_SYNC_KEYS.missing]: null } : {}),
  });
  const retitled = action.retitle ? pushableFields(fields) : null;
  if (retitled === null) return;
  // Its times are on the block now: stopped before the title goes back, it still counts as pulled.
  if (!applying.wanted()) throw new SyncStopped('pulled');
  const written = await writeEvent(applying, {
    eventId: action.eventId,
    fields: retitled,
    insert: false,
    path,
  });
  // Gone since the listing: the next one says it was deleted, and the block is marked then.
  if (written.kind === 'written') await writeOwned(applying, path, etagKeys(written.etag));
}

/** The keys a copy carried from the block it was copied from, cleared: it is a new block. */
const DETACHED = {
  [BLOCK_SYNC_KEYS.eventId]: null,
  [BLOCK_SYNC_KEYS.etag]: null,
  [BLOCK_SYNC_KEYS.calendar]: null,
  [BLOCK_SYNC_KEYS.missing]: null,
  [BLOCK_SYNC_KEYS.pending]: null,
  [BLOCK_SYNC_KEYS.syncedTitle]: null,
  [BLOCK_SYNC_KEYS.syncedStart]: null,
  [BLOCK_SYNC_KEYS.syncedEnd]: null,
};

/** Carries out one action; null for one that counts as nothing. */
async function apply(applying: Applying, action: BlockAction): Promise<Outcome> {
  switch (action.kind) {
    case 'insert':
    case 'patch':
      return push(applying, action);
    case 'pull':
      await pull(applying, action);
      return 'pulled';
    case 'adopt':
      await writeOwned(applying, action.path, {
        ...etagKeys(action.etag),
        ...(action.synced === null ? {} : syncedKeys(action.synced)),
        // Both sides hold the block's values: whatever was sent has landed.
        [BLOCK_SYNC_KEYS.pending]: null,
      });
      return null;
    case 'missing':
      await writeOwned(applying, action.path, { [BLOCK_SYNC_KEYS.missing]: true });
      return 'missing';
    case 'detach':
      await writeOwned(applying, action.path, DETACHED);
      return 'copied';
    case 'unplaced':
      return null;
  }
}

interface Tally {
  inserted: number;
  pushed: number;
  pulled: number;
  missing: number;
  conflicts: string[];
  copies: string[];
  failed: BlockFailure[];
  scopeRefused: boolean;
}

const COUNTED = {
  inserted: 'inserted',
  pushed: 'pushed',
  pulled: 'pulled',
  missing: 'missing',
} as const;

/** What one action came to, added to the tally. */
function count(tally: Tally, action: BlockAction, outcome: Outcome): void {
  if (outcome === 'copied') tally.copies.push(action.path);
  else if (outcome !== null) tally[COUNTED[outcome]] += 1;
  if (action.kind === 'pull' && action.conflict) tally.conflicts.push(action.path);
}

/**
 * Each action on its own: one that fails is reported by its block and stops
 * none of the others. Stopped, it ends where it is.
 */
async function applyAll(applying: Applying, actions: readonly BlockAction[]): Promise<Tally> {
  const tally: Tally = {
    inserted: 0,
    pushed: 0,
    pulled: 0,
    missing: 0,
    conflicts: [],
    copies: [],
    failed: [],
    scopeRefused: false,
  };
  for (const action of actions) {
    try {
      goOn(applying);
      count(tally, action, await apply(applying, action));
    } catch (cause) {
      if (cause instanceof SyncStopped) {
        if (cause.landed !== null) count(tally, action, cause.landed);
        break;
      }
      tally.failed.push({ path: action.path, problem: problemOf(cause) });
      // Every later write would be refused the same way: wait for the grant to change.
      if (refusedScope(cause)) {
        tally.scopeRefused = true;
        break;
      }
    }
  }
  return tally;
}

/** The record after a sync: the token moves on only once every write landed; the zone is the one it read on. */
function nextRecord(
  kept: BlockSyncRecord,
  {
    listed,
    whole,
    ran,
    calendarId,
    timeZone,
  }: { listed: Listed; whole: boolean; ran: number; calendarId: string; timeZone: string },
): BlockSyncRecord {
  const same = kept.calendarId === calendarId;
  return {
    calendarId,
    syncToken: whole ? listed.syncToken : same ? kept.syncToken : null,
    lastSyncAt: whole ? ran : same ? kept.lastSyncAt : null,
    timeZone,
  };
}

const pathsOf = (actions: readonly BlockAction[], kind: BlockAction['kind']) =>
  actions.filter((action) => action.kind === kind).map((action) => action.path);

const NOTHING = {
  inserted: 0,
  pushed: 0,
  pulled: 0,
  missing: 0,
  conflicts: [],
  unplaced: [],
  copies: [],
  failed: [],
  full: false,
  zoneChange: null,
} as const;

/** The zone a block's wall clock means, asked of Google only when the sync goes on. */
async function planZoneFor(ports: BlockSyncPorts, run: BlockSyncRun, wanted: () => boolean) {
  if (!wanted()) return null;
  const primaryZone = await ports.calendar.primaryTimeZone({ vault: run.vault });
  return blockPlanZone({ primaryZone, timeZone: run.timeZone });
}

/**
 * Two-way sync of the vault's blocks with the one calendar they go to (#30,
 * ADR-0030): what changed on the calendar since this Mac last looked, or all
 * of it when it has not; the blocks from two weeks ago on, any whose event
 * changed, and any note carrying one of their ids; then each block pushed,
 * pulled, marked or given its own event as `reconcileBlocks` says. Only the
 * owned `gcal_` keys and, on a pull, `start` and `end` are written,
 * byte-preserving; a block's body and its other keys are never touched, and
 * no event is ever deleted.
 *
 * What both sides agreed is kept on each block (`gcal_synced_*`), so every
 * Mac compares with the same record. The sync token, this Mac's own, moves
 * on only once every write landed, so a sync that failed part way reads the
 * same changes again; writing what it already wrote changes nothing. A sync
 * the person stops sends and writes nothing more and keeps no record.
 * Failure is a report, not a rejection.
 */
export async function syncBlocks(
  ports: BlockSyncPorts,
  run: BlockSyncRun,
): Promise<BlockSyncReport> {
  const ran = ports.clock.now();
  const wanted = run.wanted ?? ALWAYS_WANTED;
  const stopped = { ran, ...NOTHING, problem: null, scopeRefused: false };
  try {
    const fromDay = addDays(ports.clock.today(), -BLOCK_SYNC_DAYS_BEFORE);
    if (fromDay === null) throw new Error(`today (${ports.clock.today()}) is not a day`);
    const kept = ports.records.read(run.vault);
    const same = kept.calendarId === run.calendarId;
    const listed = await listCalendar(ports, { ...run, wanted }, same ? kept.syncToken : null);
    const timeZone = await planZoneFor(ports, run, wanted);
    if (timeZone === null || !wanted()) return stopped;
    const { blocks, files } = await readBlocks(ports, listed.events, fromDay);
    const fetched = await eventsOfCopies(
      ports,
      { ...run, wanted },
      { blocks, events: listed.events },
    );
    const plan = reconcileBlocks({
      blocks,
      events: [...listed.events, ...fetched],
      listedInFull: listed.full,
      calendarId: run.calendarId,
      timeZone,
      fromDay,
    });
    const applying: Applying = {
      ports,
      run,
      timeZone,
      files,
      wanted,
      vaultId: once(() =>
        ensureVaultId({
          fs: ports.fs,
          markdown: ports.markdown,
          settings: ports.settings,
          rng: ports.rng,
          beforeWrite: () => {
            if (!wanted()) throw new SyncStopped();
          },
        }),
      ),
    };
    const tally = await applyAll(applying, plan.actions);
    if (wanted()) {
      const whole = tally.failed.length === 0;
      ports.records.write(
        run.vault,
        nextRecord(kept, { listed, whole, ran, calendarId: run.calendarId, timeZone }),
      );
    }
    return {
      ran,
      ...tally,
      unplaced: pathsOf(plan.actions, 'unplaced'),
      full: listed.full,
      zoneChange: blockZoneChange({ from: kept.timeZone, to: timeZone, at: ran }),
      problem: null,
    };
  } catch (cause) {
    // Stopped before any action ran: nothing was written, and no record is kept.
    if (cause instanceof SyncStopped) return stopped;
    return { ran, ...NOTHING, problem: problemOf(cause), scopeRefused: refusedScope(cause) };
  }
}
