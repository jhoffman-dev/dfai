import {
  addDays,
  blockOnDisk,
  compileBlocksToSyncQuery,
  createVaultPath,
  isBlockType,
  isScopeRefusal,
  newBlockEventId,
  noteTitle,
  reconcileBlocks,
  splitFrontmatter,
  BLOCK_KEYS,
  BLOCK_SYNC_DAYS_BEFORE,
  BLOCK_SYNC_KEYS,
  EVENT_ID_LOOKUP_SIZE,
  type BlockAction,
  type BlockEvent,
  type BlockOnDisk,
  type BlockSyncFields,
  type GoogleProblem,
} from '@dfai/domain';
import type { IndexPort, QueryResult } from '../index/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { Clock, Rng } from '../ports.ts';
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
  /** Blocks carrying an event id an earlier block has, left alone. */
  readonly duplicates: readonly string[];
  readonly failed: readonly BlockFailure[];
  /** Whether the calendar was listed in full rather than by what changed. */
  readonly full: boolean;
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
  readonly rng: Rng;
}

export interface BlockSyncRun {
  readonly vault: string;
  /** The one calendar blocks go to (`google_calendar`). No other is ever called. */
  readonly calendarId: string;
  /** The Mac's zone: times are written on it only when Google names none for the calendar. */
  readonly timeZone: string;
  /** Asked before each call to Google and each write; false once the person stops the sync. */
  readonly wanted?: () => boolean;
}

const ALWAYS_WANTED = () => true;

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
async function listCalendar(ports: BlockSyncPorts, run: BlockSyncRun, token: string | null) {
  const list = (syncToken: string | null) =>
    ports.calendar.listBlockEvents({ vault: run.vault, calendarId: run.calendarId, syncToken });
  const first = await list(token);
  const answer = first.kind === 'expired' ? await list(null) : first;
  if (answer.kind === 'expired') throw new Error('Google asked for a full listing of blocks again');
  return { ...answer, full: token === null || first.kind === 'expired' } satisfies Listed;
}

const pathsIn = (result: QueryResult): string[] => {
  const column = result.columns.indexOf('path');
  return result.rows.map((row) => String(row[column]));
};

function idBatches(events: readonly BlockEvent[]): string[][] {
  const ids = [...new Set(events.map((event) => event.id))];
  const batches: string[][] = [];
  for (let at = 0; at < ids.length; at += EVENT_ID_LOOKUP_SIZE) {
    batches.push(ids.slice(at, at + EVENT_ID_LOOKUP_SIZE));
  }
  return batches.length === 0 ? [[]] : batches;
}

/** The blocks a sync may write to, as their files say now, not as the index last read them. */
async function readBlocks(ports: BlockSyncPorts, events: readonly BlockEvent[], fromDay: string) {
  const paths = new Set<string>();
  for (const ids of idBatches(events)) {
    const { sql, parameters } = compileBlocksToSyncQuery({ ids, fromDay });
    for (const path of pathsIn(await ports.index.query(sql, parameters))) paths.add(path);
  }
  const files = await ports.fs.readNotes([...paths]);
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
  return { blocks, files: new Map(files.map((file) => [file.path, file])) };
}

interface Applying {
  readonly ports: BlockSyncPorts;
  readonly run: BlockSyncRun;
  readonly timeZone: string;
  readonly files: Map<string, NoteFile>;
  readonly agreed: Record<string, BlockSyncFields>;
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
  const modified = await ports.fs.writeTextFile({
    path: createVaultPath(path),
    contents,
    expectedModified: file.modified,
  });
  files.set(path, { ...file, text: contents, modified });
}

/** Writes the event, as an insert or a patch; an insert whose id is taken already landed once, and is patched. */
async function writeEvent(
  applying: Applying,
  { eventId, fields, insert }: { eventId: string; fields: BlockSyncFields; insert: boolean },
): Promise<BlockEventWrite> {
  const { calendar } = applying.ports;
  const call = {
    vault: applying.run.vault,
    calendarId: applying.run.calendarId,
    eventId,
    fields,
    timeZone: applying.timeZone,
  };
  const written = insert
    ? await calendar.insertBlockEvent(call)
    : await calendar.patchBlockEvent(call);
  return written.kind === 'exists' ? calendar.patchBlockEvent(call) : written;
}

type Outcome = 'inserted' | 'pushed' | 'pulled' | 'missing' | 'adopted';

/** Pushes a block to its event; with no event id yet, one is written onto the block first. */
async function push(
  applying: Applying,
  action: Extract<BlockAction, { kind: 'insert' | 'patch' }>,
): Promise<Outcome> {
  const insert = action.kind === 'insert';
  let eventId = action.eventId;
  if (eventId === null) {
    eventId = newBlockEventId(() => applying.ports.rng.next());
    await writeOwned(applying, action.path, {
      [BLOCK_SYNC_KEYS.eventId]: eventId,
      [BLOCK_SYNC_KEYS.calendar]: applying.run.calendarId,
    });
  }
  const written = await writeEvent(applying, { eventId, fields: action.fields, insert });
  if (written.kind !== 'written') {
    if (insert) throw new Error('Google would not make the block’s event');
    await writeOwned(applying, action.path, { [BLOCK_SYNC_KEYS.missing]: true });
    return 'missing';
  }
  await writeOwned(applying, action.path, { [BLOCK_SYNC_KEYS.etag]: written.etag });
  applying.agreed[eventId] = action.fields;
  return insert ? 'inserted' : 'pushed';
}

/** Carries out one action; null for one with nothing to write. */
async function apply(applying: Applying, action: BlockAction): Promise<Outcome | null> {
  switch (action.kind) {
    case 'insert':
    case 'patch':
      return push(applying, action);
    case 'pull':
      await writeOwned(applying, action.path, {
        [BLOCK_KEYS.start]: action.fields.start,
        [BLOCK_KEYS.end]: action.fields.end,
        [BLOCK_SYNC_KEYS.etag]: action.etag,
        ...(action.returned ? { [BLOCK_SYNC_KEYS.missing]: null } : {}),
      });
      applying.agreed[action.eventId] = action.fields;
      return 'pulled';
    case 'adopt':
      await writeOwned(applying, action.path, { [BLOCK_SYNC_KEYS.etag]: action.etag });
      applying.agreed[action.eventId] = action.fields;
      return 'adopted';
    case 'missing':
      await writeOwned(applying, action.path, { [BLOCK_SYNC_KEYS.missing]: true });
      return 'missing';
    case 'unplaced':
    case 'duplicate':
      return null;
  }
}

interface Tally {
  inserted: number;
  pushed: number;
  pulled: number;
  missing: number;
  conflicts: string[];
  failed: BlockFailure[];
  scopeRefused: boolean;
}

const COUNTED: Partial<Record<Outcome, 'inserted' | 'pushed' | 'pulled' | 'missing'>> = {
  inserted: 'inserted',
  pushed: 'pushed',
  pulled: 'pulled',
  missing: 'missing',
};

/** Each action on its own: one that fails is reported by its block and stops none of the others. */
async function applyAll(
  applying: Applying,
  actions: readonly BlockAction[],
  wanted: () => boolean,
): Promise<Tally> {
  const tally: Tally = {
    inserted: 0,
    pushed: 0,
    pulled: 0,
    missing: 0,
    conflicts: [],
    failed: [],
    scopeRefused: false,
  };
  for (const action of actions) {
    if (!wanted()) break;
    try {
      const outcome = await apply(applying, action);
      const counted = outcome === null ? undefined : COUNTED[outcome];
      if (counted !== undefined) tally[counted] += 1;
      if (action.kind === 'pull' && action.conflict) tally.conflicts.push(action.path);
    } catch (cause) {
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

/** The record after a sync: agreed values for what landed, the token only once every write did. */
function nextRecord(
  kept: BlockSyncRecord,
  {
    listed,
    agreed,
    whole,
    ran,
    calendarId,
  }: {
    listed: Listed;
    agreed: Record<string, BlockSyncFields>;
    whole: boolean;
    ran: number;
    calendarId: string;
  },
): BlockSyncRecord {
  const same = kept.calendarId === calendarId;
  return {
    calendarId,
    syncToken: whole ? listed.syncToken : same ? kept.syncToken : null,
    agreed: { ...(same ? kept.agreed : {}), ...agreed },
    lastSyncAt: whole ? ran : same ? kept.lastSyncAt : null,
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
  duplicates: [],
  failed: [],
  full: false,
} as const;

/**
 * Two-way sync of the vault's blocks with the one calendar they go to (#30,
 * ADR-0030): what changed on the calendar since this Mac last looked, or all
 * of it when it has not; the blocks from two weeks ago on, and any whose
 * event changed; then each block pushed, pulled or marked as
 * `reconcileBlocks` says. Only the owned `gcal_` keys and, on a pull, `start`
 * and `end` are written, byte-preserving; a block's body and its other keys
 * are never touched, and no event is ever deleted.
 *
 * The sync token moves on only once every write landed, so a sync that
 * failed part way reads the same changes again; writing what it already
 * wrote changes nothing. A sync the person stops writes nothing more and
 * keeps no record. Failure is a report, not a rejection.
 */
export async function syncBlocks(
  ports: BlockSyncPorts,
  run: BlockSyncRun,
): Promise<BlockSyncReport> {
  const ran = ports.clock.now();
  const wanted = run.wanted ?? ALWAYS_WANTED;
  try {
    const fromDay = addDays(ports.clock.today(), -BLOCK_SYNC_DAYS_BEFORE);
    if (fromDay === null) throw new Error(`today (${ports.clock.today()}) is not a day`);
    const kept = ports.records.read(run.vault);
    const same = kept.calendarId === run.calendarId;
    const listed = await listCalendar(ports, run, same ? kept.syncToken : null);
    if (!wanted()) return { ran, ...NOTHING, problem: null, scopeRefused: false };
    const { blocks, files } = await readBlocks(ports, listed.events, fromDay);
    const timeZone = listed.timeZone ?? run.timeZone;
    const plan = reconcileBlocks({
      blocks,
      events: listed.events,
      listedInFull: listed.full,
      lastSync: same ? kept.agreed : {},
      calendarId: run.calendarId,
      timeZone,
    });
    const applying: Applying = { ports, run, timeZone, files, agreed: { ...plan.agreed } };
    const tally = await applyAll(applying, plan.actions, wanted);
    if (wanted()) {
      const whole = tally.failed.length === 0;
      const record = nextRecord(kept, {
        listed,
        agreed: applying.agreed,
        whole,
        ran,
        calendarId: run.calendarId,
      });
      ports.records.write(run.vault, record);
    }
    return {
      ran,
      ...tally,
      unplaced: pathsOf(plan.actions, 'unplaced'),
      duplicates: pathsOf(plan.actions, 'duplicate'),
      full: listed.full,
      problem: null,
    };
  } catch (cause) {
    return { ran, ...NOTHING, problem: problemOf(cause), scopeRefused: refusedScope(cause) };
  }
}
