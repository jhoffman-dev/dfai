import {
  compileImportDeclarationsQuery,
  compileImportOutcomesQuery,
  compileLinkHoldersQuery,
  createVaultPath,
  IMPORT_OUTCOMES_PAGE,
  importOutcomesOf,
  isMeetingInboxPath,
  LINK_NAMES_PER_QUERY,
  noteChangesBetween,
  type CompiledQuery,
  type ImportOutcome,
  type LinkChanges,
  type NoteChange,
  type NoteVersion,
  type VaultPath,
} from '@dfai/domain';
import type { VaultFsPort } from '../vault/ports.ts';
import { listVaultNoteFiles } from '../vault/read-vault.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import { inThreadNoteDeriver, type NoteDeriver, type UnreadNote } from './note-deriver.ts';
import type { IndexedNote, IndexEntry, IndexPort, IndexWriteScope } from './ports.ts';
import { diffManifest } from './manifest-diff.ts';

/**
 * Notes are read, derived and written a batch at a time. A batch crosses to
 * the host twice and to the deriver once, each a message the window's thread
 * has to put together, so it is kept small enough that none of them is felt
 * (#135): at 200 a batch of long notes was megabytes in one go.
 */
export const INDEX_BATCH_SIZE = 50;

/** A build given up part-way because it is no longer wanted: its vault was closed. Not a failure. */
export class IndexSyncAbandoned extends Error {
  constructor() {
    super('the index was no longer wanted');
    this.name = 'IndexSyncAbandoned';
  }
}

export interface IndexRefresh {
  readonly indexed: number;
  readonly removed: number;
  readonly unchanged: number;
  /** Each note added, changed or removed since `previous` (P28-03); none when nothing was. */
  readonly changes: readonly NoteChange[];
  /**
   * The stale notes that could not be read as notes (#135). Nothing is
   * written for one: a note the index has never held stays out of it, and a
   * note it does hold keeps the rows of the last version that could be read,
   * so it can still be found while it is torn. Each is tried again by the
   * next refresh.
   */
  readonly failed: readonly UnreadNote[];
  /**
   * Every stale note this refresh did not put in the index: those in
   * `failed`, and those the host left out of its read (gone, unreadable, not
   * text). The index holds an older version of each, or none.
   */
  readonly notRead: readonly string[];
  /** Why the notes were read on the window's thread, when they had to be; null when they were not. */
  readonly inWindow: string | null;
}

export interface RefreshOptions {
  fs: VaultFsPort;
  index: IndexPort;
  markdown: MarkdownPort;
  /**
   * Where the notes are read into rows. Left out, on the calling thread with
   * `markdown`; the app hands one that does it on another thread (#135).
   */
  deriver?: NoteDeriver;
  /**
   * Asked between steps of a build: false once the vault it is building for
   * is no longer the one open, and the build stops with `IndexSyncAbandoned`.
   */
  stillWanted?: () => boolean;
  /**
   * Aborted when the build is no longer wanted, for a build that is waiting
   * and cannot ask: one held up reading a batch stops at once rather than
   * when the batch comes back.
   */
  abandoned?: AbortSignal;
  /** The vault being indexed, named on every write so the host can refuse one that arrives late. */
  vault?: string;
  /** Called after each batch, for showing progress on a big vault. */
  onProgress?: (done: number, total: number) => void;
  /**
   * Every note as it was when the vault was last looked at, which `changes`
   * is measured from. Left out, it is what the index holds — which a rebuild
   * has just cleared, and a delete in the app has already let go of.
   */
  previous?: ReadonlyMap<string, NoteVersion>;
  /**
   * Notes something other than the app was seen to change — the watcher's
   * report, with the app's own echo left out — read again even when their
   * time and size are as the index holds them. On a disk that keeps the time
   * to the second (HFS+), to two (exFAT) or to a server's (SMB, NFS), another
   * program's same-length write within the same tick leaves both as they
   * were, and only the bytes tell (#245).
   */
  recheck?: readonly string[];
}

/**
 * Brings the index in line with the vault.
 *
 * Only notes whose size or modification time differ are re-read, so an ordinary
 * launch does almost no work — and the few `recheck` names, whose bytes may
 * have changed under a time and size that did not. Deciding what a note contains happens here rather
 * than in the host, so the index always agrees with what the editor would show.
 *
 * It indexes user space, through the same listing the editor resolves links
 * against — a note that is not a link target must not be a search result either.
 */
export async function refreshIndex({
  fs,
  index,
  markdown,
  deriver = inThreadNoteDeriver(markdown),
  stillWanted = () => true,
  abandoned,
  vault,
  onProgress,
  previous,
  recheck = [],
}: RefreshOptions): Promise<IndexRefresh> {
  const scope = vault === undefined ? undefined : { vault };
  const notes = await listVaultNoteFiles({ fs });
  const current = new Map<string, (typeof notes)[number]>(
    notes.map((note) => [note.path as string, note]),
  );
  const known = await heldEntries(index);

  const { stale, removed, added } = diffManifest({ listed: notes, held: known, recheck });
  if (removed.length > 0) await index.remove(removed.map(createVaultPath), scope);

  // A note made or gone can change which note an unchanged note's link means,
  // in a property or in the body (#431).
  const staleByLink = await linkHolders(index, { made: added, gone: removed });
  const stalePaths = new Set(stale.map((note) => note.path as string));
  for (const path of staleByLink) {
    const note = current.get(path);
    if (note !== undefined && !stalePaths.has(path)) {
      stale.push(note);
      stalePaths.add(path);
    }
  }

  const notePaths = [...current.keys()].map(createVaultPath);
  const { reread, failed, inWindow } = await indexNotes({
    fs,
    index,
    deriver,
    stillWanted,
    ...(abandoned !== undefined && { abandoned }),
    ...(scope !== undefined && { scope }),
    notePaths,
    stale,
    ...(onProgress !== undefined && { onProgress }),
  });

  return {
    indexed: stale.length - failed.length,
    removed: removed.length,
    unchanged: current.size - stale.length,
    failed,
    notRead: stale.map(({ path }) => path as string).filter((path) => !reread.has(path)),
    inWindow,
    changes: noteChangesBetween(
      previous ?? known,
      versionsNow({ paths: current.keys(), reread, known, previous: previous ?? known }),
    ),
  };
}

/**
 * What the index holds of each note, by path, with how the meeting import
 * settled it where meeting files land, and whether it declares the import's
 * contract: the manifest says neither, and a note's stamp is what tells the
 * import's own write from an edit (#92), its declaration whether it is the
 * import's at all (#214). An empty index is not asked.
 *
 * Both are read a page at a time, since the host cuts a result short. A
 * result it still cut short is no answer, for a stamp missed would read as a
 * meeting that is new; nor is a query that fails. The manifest still stands
 * then, and notes where meetings land are taken as already arrived, which at
 * worst misses one edit of a let-in meeting and never runs a rule on one
 * again — the safe side of not knowing. That holds for a rebuild too: it
 * must not start from nothing, or every let-in meeting arrives again.
 */
export async function heldEntries(index: IndexPort): Promise<Map<string, IndexEntry>> {
  const entries = await index.manifest();
  if (entries.length === 0) return new Map();
  const stamps = await rowsHeld(index, compileImportOutcomesQuery);
  const declarations =
    stamps === null ? null : await rowsHeld(index, compileImportDeclarationsQuery);
  if (stamps === null || declarations === null) {
    return new Map(
      entries.map((entry) => [
        entry.path,
        isMeetingInboxPath(entry.path) ? { ...entry, arrivalHeard: true } : entry,
      ]),
    );
  }
  const outcomes = importOutcomesOf(stamps);
  const declared = new Set(declarations.map(([path]) => String(path)));
  return new Map(entries.map((entry) => [entry.path, withImportSigns(entry, outcomes, declared)]));
}

function withImportSigns(
  entry: IndexEntry,
  outcomes: ReadonlyMap<string, ImportOutcome>,
  declared: ReadonlySet<string>,
): IndexEntry {
  const importOutcome = outcomes.get(entry.path);
  return {
    ...entry,
    ...(importOutcome !== undefined && { importOutcome }),
    ...(declared.has(entry.path) && { importDeclared: true as const }),
  };
}

/** Every row of a paged meeting query; null when the index cannot be asked or cuts a page short. */
async function rowsHeld(
  index: IndexPort,
  compile: (page: number) => CompiledQuery,
): Promise<(readonly unknown[])[] | null> {
  const rows: (readonly unknown[])[] = [];
  for (let page = 0; ; page++) {
    const { sql, parameters } = compile(page);
    let result;
    try {
      result = await index.query(sql, parameters);
    } catch {
      // Safe to go without: the caller takes every note where meetings land as already arrived.
      return null;
    }
    // A list cut short is as unknown as one that failed: what is missing cannot be told from not there.
    if (result.truncated) return null;
    rows.push(...result.rows);
    if (result.rows.length < IMPORT_OUTCOMES_PAGE) return rows;
  }
}

/**
 * Reads and indexes the stale notes in batches; answers with what was read, by
 * path, and what could not be. Every step waits on another thread or the host,
 * so the calling thread is never held for longer than it takes to pass a batch on.
 */
async function indexNotes({
  fs,
  index,
  deriver,
  stillWanted,
  abandoned,
  scope,
  notePaths,
  stale,
  onProgress,
}: Required<Pick<RefreshOptions, 'fs' | 'index' | 'deriver' | 'stillWanted'>> &
  Pick<RefreshOptions, 'onProgress' | 'abandoned'> & {
    scope?: IndexWriteScope;
    notePaths: readonly VaultPath[];
    stale: readonly { path: VaultPath }[];
  }): Promise<{ reread: Map<string, IndexedNote>; failed: UnreadNote[]; inWindow: string | null }> {
  const reread = new Map<string, IndexedNote>();
  const failed: UnreadNote[] = [];
  let inWindow: string | null = null;
  const abandonIfUnwanted = () => {
    if (abandoned?.aborted === true || !stillWanted()) throw new IndexSyncAbandoned();
  };
  const deriving = deriver.begin(notePaths);
  try {
    for (let offset = 0; offset < stale.length; offset += INDEX_BATCH_SIZE) {
      const batch = stale.slice(offset, offset + INDEX_BATCH_SIZE);
      abandonIfUnwanted();
      const files = await fs.readNotes(batch.map((note) => note.path));
      // The host answers for whichever vault is open: read after a switch, these are not this vault's.
      abandonIfUnwanted();
      const derived = await unlessAbandoned(deriving.derive(files), abandoned);
      abandonIfUnwanted();
      await index.put(derived.notes, scope).catch((cause: unknown) => {
        // Refused by the host because the vault changed under it: given up, not failed.
        abandonIfUnwanted();
        throw cause;
      });
      for (const note of derived.notes) reread.set(note.path, note);
      failed.push(...derived.failed);
      inWindow ??= derived.inWindow ?? null;

      onProgress?.(Math.min(offset + INDEX_BATCH_SIZE, stale.length), stale.length);
    }
  } finally {
    deriving.end();
  }
  return { reread, failed, inWindow };
}

/** What `waiting` settles with, unless the build is abandoned first: then it stops waiting. */
function unlessAbandoned<T>(waiting: Promise<T>, abandoned: AbortSignal | undefined): Promise<T> {
  if (abandoned === undefined) return waiting;
  return new Promise<T>((resolve, reject) => {
    const giveUp = () => reject(new IndexSyncAbandoned());
    if (abandoned.aborted) return giveUp();
    abandoned.addEventListener('abort', giveUp, { once: true });
    waiting.then(resolve, reject).finally(() => abandoned.removeEventListener('abort', giveUp));
  });
}

/**
 * Every note in the vault as it is now: as just read, or as the index or the
 * last look at the vault had it. A note the host lists but could not read — a
 * cloud placeholder, a file too big or half written — is still there, so it
 * keeps the version last known of it; one never read at all is left out until
 * it can be.
 */
function versionsNow({
  paths,
  reread,
  known,
  previous,
}: {
  paths: Iterable<string>;
  reread: ReadonlyMap<string, NoteVersion>;
  known: ReadonlyMap<string, IndexEntry>;
  previous: ReadonlyMap<string, NoteVersion>;
}): Map<string, NoteVersion> {
  const versions = new Map<string, NoteVersion>();
  for (const path of paths) {
    const version = reread.get(path) ?? known.get(path) ?? previous.get(path);
    if (version !== undefined) versions.set(path, version);
  }
  return versions;
}

/**
 * Takes notes the app has just moved or deleted out of the index at once, and
 * with them every note whose link — a relation or in the body — pointed at
 * them. The refresh that follows cannot see a removal it did not make, so it
 * would never re-resolve those links; taken out too, the holders are read
 * again as new notes. The notes linking to a holder are not: their links
 * already point at it (#440).
 */
export async function forgetNotes(index: IndexPort, paths: readonly VaultPath[]): Promise<void> {
  if (paths.length === 0) return;
  const holders = await linkHolders(index, { made: [], gone: paths });
  await index.remove([...new Set<string>([...paths, ...holders])].map(createVaultPath));
}

/**
 * The indexed notes holding a link — a relation or in the body — that opens
 * one of `paths`, each once: found by the index's `dst` columns, so the
 * vault is not read to find them (#439).
 */
export async function notesLinkingTo(
  index: IndexPort,
  paths: readonly VaultPath[],
): Promise<VaultPath[]> {
  if (paths.length === 0) return [];
  const holders = await linkHolders(index, { made: [], gone: paths });
  return [...new Set(holders)].sort().map(createVaultPath);
}

/**
 * The indexed notes holding a link, a relation or in the body, that these
 * notes made or gone could move — asked before those notes' own rows change,
 * so a note that has gone is still there to be pointed at. Every page of each
 * answer is read: the host cuts a long one short, and a holder left out would
 * never be read again.
 */
async function linkHolders(index: IndexPort, changes: LinkChanges): Promise<string[]> {
  const changed = [
    ...changes.made.map((path) => ({ path, made: true })),
    ...changes.gone.map((path) => ({ path, made: false })),
  ];
  const holders: string[] = [];
  for (let at = 0; at < changed.length; at += LINK_NAMES_PER_QUERY) {
    const batch = changed.slice(at, at + LINK_NAMES_PER_QUERY);
    const asked: LinkChanges = {
      made: batch.filter((note) => note.made).map((note) => note.path),
      gone: batch.filter((note) => !note.made).map((note) => note.path),
    };
    for (let offset = 0; ;) {
      const { sql, parameters } = compileLinkHoldersQuery(asked, offset);
      const result = await index.query(sql, parameters);
      holders.push(...result.rows.map((row) => String(row[0])));
      if (!result.truncated || result.rows.length === 0) break;
      offset += result.rows.length;
    }
  }
  return holders;
}
