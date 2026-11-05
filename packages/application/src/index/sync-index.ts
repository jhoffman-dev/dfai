import {
  indexFailedReport,
  indexInWindowReport,
  indexNotKeptReport,
  indexRebuiltReport,
  messageWithoutPaths,
  notesNotIndexedReport,
  versionsAfter,
  type NoteChange,
  type NoteVersion,
} from '@dfai/domain';
import type { ActivityLog } from '../activity/ports.ts';
import type { NoteChanges } from './note-changes.ts';
import type { IndexPort, IndexStats } from './ports.ts';
import type { UnreadNote } from './note-deriver.ts';
import type { OwnWrites } from '../vault/own-writes.ts';
import {
  heldEntries,
  IndexSyncAbandoned,
  refreshIndex,
  type RefreshOptions,
} from './refresh-index.ts';

/**
 * What a sync is measured from: every note as it was, or null when nothing is
 * known of the vault's past — the sync is then a baseline, and reports nothing.
 */
export type SyncBaseline = ReadonlyMap<string, NoteVersion> | null;

export interface IndexSync {
  /** What the index holds once it is in line with the vault. */
  readonly stats: IndexStats;
  /** Each note added, changed or removed since the baseline; none for a baseline of null. */
  readonly changes: readonly NoteChange[];
  /** Every note as it now is: the baseline of the next sync. */
  readonly versions: ReadonlyMap<string, NoteVersion>;
  /** The notes that could not be read as notes; see `IndexRefresh.failed`. */
  readonly failed: readonly UnreadNote[];
  /** The stale notes not put in the index; see `IndexRefresh.notRead`. */
  readonly notRead: readonly string[];
  /** Why the notes were read on the window's thread, when they had to be. */
  readonly inWindow: string | null;
  /** False when the host keeps the index only while the page is open (`IndexOpening.kept`). */
  readonly kept: boolean;
}

/**
 * Opens the index and brings it in line with the vault — from nothing, when
 * asked to rebuild it — and says which notes changed on the way.
 *
 * Changes are measured from `previous` when given. Otherwise from what the
 * index held, asked before anything is written — unless the host has only
 * just made the index (there was none, or one of an older shape was thrown
 * away): then nothing is known of the vault's past, and the sync is a
 * baseline that reports no changes, rather than every note as new.
 *
 * A rebuild, and any failure, is said in the Activity log (U-28); the refresh
 * every change sets off is not, since it is routine. The failure is passed on
 * as well, for the window to show. Notes that could not be read are said too,
 * unless they are the ones `unreadBefore` names: a note left torn is tried
 * again by every sync, and is worth one line, not one per save (#135). A sync
 * given up because its vault closed is neither a failure nor said.
 */
export async function syncIndex({
  fromScratch,
  activity,
  previous,
  unreadBefore,
  onBaseline,
  ...options
}: Omit<RefreshOptions, 'previous'> & {
  fromScratch: boolean;
  activity: ActivityLog;
  previous?: SyncBaseline;
  /** The notes the last sync of this vault could not read, as `unreadKey` names them. */
  unreadBefore?: string;
  /** Told the baseline before anything is written, so a sync that fails can be tried again from it. */
  onBaseline?: (baseline: SyncBaseline) => void;
}): Promise<IndexSync> {
  // Taken before the first wait: a rebuild finishing after a switch is still this vault's.
  const recorder = activity.inOpenVault();
  try {
    const opening = await options.index.open();
    const baseline =
      previous !== undefined
        ? previous
        : opening.fresh
          ? null
          : await versionsHeld(options.index, fromScratch);
    onBaseline?.(baseline);
    if (fromScratch) await options.index.clear();
    const measuredFrom = baseline ?? new Map<string, NoteVersion>();
    const refresh = await refreshIndex({ ...options, previous: measuredFrom });
    const stats = await options.index.stats();
    if (fromScratch) recorder.record(indexRebuiltReport(stats.notes));
    const [first, ...rest] = refresh.failed;
    if (first !== undefined && unreadKey(refresh.failed) !== unreadBefore) {
      recorder.record(notesNotIndexedReport([first, ...rest]));
    }
    return {
      stats,
      changes: baseline === null ? [] : refresh.changes,
      versions: versionsAfter(measuredFrom, refresh.changes),
      failed: refresh.failed,
      notRead: refresh.notRead,
      inWindow: refresh.inWindow,
      kept: opening.kept !== false,
    };
  } catch (cause) {
    if (cause instanceof IndexSyncAbandoned) throw cause;
    const problem = messageWithoutPaths(cause);
    recorder.record(indexFailedReport({ rebuilding: fromScratch, problem }));
    throw cause;
  }
}

/** Which notes could not be read, as one value to tell one sync's from the next's. */
const unreadKey = (failed: readonly UnreadNote[]): string =>
  JSON.stringify(failed.map(({ path }) => path).sort());

/**
 * The notes the index holds, asked before a rebuild clears them, so reading
 * them all again is not mistaken for their arriving.
 */
async function versionsHeld(
  index: IndexPort,
  fromScratch: boolean,
): Promise<Map<string, NoteVersion>> {
  try {
    const entries = await heldEntries(index);
    return new Map(
      [...entries.values()].map(
        ({ path, type, digest, importOutcome, importDeclared, arrivalHeard }) => [
          path,
          {
            type,
            digest,
            ...(importOutcome !== undefined && { importOutcome }),
            ...(importDeclared !== undefined && { importDeclared }),
            ...(arrivalHeard !== undefined && { arrivalHeard }),
          },
        ],
      ),
    );
  } catch (cause) {
    // A rebuild is the remedy for an index that cannot answer, so it must not
    // wait on one: it goes ahead, and its notes are reported as added. Any
    // other sync fails here, as its refresh would on asking the same question.
    if (fromScratch) return new Map();
    throw cause;
  }
}

/**
 * The one way the app brings the index in line with the vault: on opening it,
 * after every change, and when asked to rebuild it.
 *
 * Syncs run one after another, so two never read the same change and report
 * it twice. Each publishes what changed since the last one in the same vault —
 * remembered here rather than read from the index, which a rebuild clears and
 * a delete in the app lets go of before the sync that follows can see it. A
 * sync that fails is tried again from the same baseline, so what it found is
 * not lost with it.
 *
 * The host's ports answer for whichever vault is open, so a sync asked for a
 * vault that is no longer open — queued before a switch, or caught by one —
 * would read the other vault's notes under this one's name. It is dropped
 * instead: nothing is published or remembered, and it settles with null. One
 * caught mid-build stops at its next batch rather than reading the rest (#135).
 */
export interface IndexSyncer {
  /** Settles with what the index then holds, after any sync already under way; null when dropped. */
  sync(args: {
    /** The vault being synced: what is remembered of another is not this one's past. */
    vault: string;
    fromScratch: boolean;
    onProgress?: RefreshOptions['onProgress'];
    /** Notes to read again whatever their time and size; see `RefreshOptions.recheck`. */
    recheck?: RefreshOptions['recheck'];
  }): Promise<IndexStats | null>;
}

export function createIndexSyncer({
  changes,
  openVault,
  ownWrites,
  onNotKept,
  ...ports
}: Omit<RefreshOptions, 'onProgress' | 'previous' | 'stillWanted' | 'abandoned' | 'vault'> & {
  activity: ActivityLog;
  /** Where each sync's changes are published, when it has any. */
  changes: NoteChanges;
  /**
   * Told which of the app's own writes each sync that finished took in, so
   * the watcher's echo of one is not refreshed for again (#254).
   */
  ownWrites?: Pick<OwnWrites, 'lastWrite' | 'refreshed'>;
  /** The vault open now, which the host's ports answer for; null when none is. */
  openVault: () => string | null;
  /** Told once, with what to say, when the host keeps the index only while the page is open (#761). */
  onNotKept?: (message: string) => void;
}): IndexSyncer {
  let queue: Promise<unknown> = Promise.resolve();
  let remembered: { vault: string; versions: SyncBaseline } | null = null;
  let unread: { vault: string; key: string } | null = null;
  /** The sync under way, and the way to tell it that it is no longer wanted. */
  let running: { vault: string; abandon: AbortController } | null = null;
  let saidInWindow = false;
  let saidNotKept = false;

  const syncOnce: IndexSyncer['sync'] = async ({ vault, fromScratch, onProgress, recheck }) => {
    if (openVault() !== vault) return null;
    const previous = remembered?.vault === vault ? remembered.versions : undefined;
    // Every write recorded by now is on disk before this sync reads the vault.
    const through = ownWrites?.lastWrite();
    const abandon = new AbortController();
    running = { vault, abandon };
    const synced = await syncIndex({
      ...ports,
      fromScratch,
      vault,
      abandoned: abandon.signal,
      stillWanted: () => openVault() === vault,
      ...(onProgress !== undefined && { onProgress }),
      ...(recheck !== undefined && { recheck }),
      ...(previous !== undefined && { previous }),
      ...(unread?.vault === vault && { unreadBefore: unread.key }),
      onBaseline: (baseline) => {
        remembered = { vault, versions: baseline };
      },
    })
      .catch((cause: unknown) => {
        if (cause instanceof IndexSyncAbandoned) return null;
        throw cause;
      })
      .finally(() => {
        running = null;
      });
    // What was read may have been another vault's, opened while this sync ran.
    if (synced === null || openVault() !== vault) return null;
    // Said once, however many syncs follow: it is the app's state, not this sync's news.
    if (synced.inWindow !== null && !saidInWindow) {
      saidInWindow = true;
      ports.activity.inOpenVault().record(indexInWindowReport(synced.inWindow));
    }
    if (!synced.kept && !saidNotKept) {
      saidNotKept = true;
      const report = indexNotKeptReport();
      ports.activity.inOpenVault().record(report);
      onNotKept?.(report.message);
    }
    remembered = { vault, versions: synced.versions };
    unread = { vault, key: unreadKey(synced.failed) };
    if (through !== undefined) {
      ownWrites?.refreshed({ vault, through, unread: synced.notRead });
    }
    if (synced.changes.length > 0) changes.publish({ vault, changes: synced.changes });
    return synced.stats;
  };

  return {
    sync(args) {
      // A sync for another vault means the one running is for a vault no
      // longer open. It is told now: it may be waiting on something that
      // will not come back soon, and this one waits behind it (#135).
      if (running !== null && running.vault !== args.vault) running.abandon.abort();
      const next = queue.then(() => syncOnce(args));
      // The queue only orders; each caller gets its own sync's outcome.
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
