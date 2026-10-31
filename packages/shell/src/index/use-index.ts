import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createIndexSyncer,
  type ActivityLog,
  type IndexPort,
  type MarkdownPort,
  type NoteChanges,
  type NoteDeriver,
  type OwnWrites,
  type VaultFsPort,
} from '@dfai/application';
import {
  createIndexStatusStore,
  useIndexStatus,
  type IndexStatus,
  type IndexStatusStore,
} from './index-status-store.ts';
import { createSyncQueue, type QueuedSync, type SyncRequest } from './sync-queue.ts';

export type { IndexStatus } from './index-status-store.ts';

export interface IndexPorts {
  fs: VaultFsPort;
  index: IndexPort;
  markdown: MarkdownPort;
  /** Where notes are read into rows; on this thread when left out, which only a test should do. */
  deriver?: NoteDeriver;
}

/** How far a build of the index has got: notes done, of how many. */
export interface IndexProgress {
  readonly done: number;
  readonly total: number;
}

/**
 * A build's progress, for whoever shows it to subscribe to (#135). It is kept
 * out of `IndexStatus` on purpose: the status is what the whole window hangs
 * off, and one that moved with every batch re-rendered the app, and re-ran
 * everything that reads the index, a hundred times a build.
 */
export interface IndexProgressStore {
  subscribe(listener: () => void): () => void;
  current(): IndexProgress;
}

const NOT_STARTED: IndexProgress = { done: 0, total: 0 };

function createIndexProgress(): IndexProgressStore & { set(progress: IndexProgress): void } {
  let progress = NOT_STARTED;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    current: () => progress,
    set(next) {
      progress = next;
      for (const listener of listeners) listener();
    },
  };
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Counts what the syncer publishes, so a sync can tell whether it found anything. */
function countingPublishes(changes: NoteChanges): NoteChanges & { published(): number } {
  let published = 0;
  return {
    publish(news) {
      published += 1;
      changes.publish(news);
    },
    subscribe: (listener) => changes.subscribe(listener),
    published: () => published,
  };
}

/** Says the index is ready, telling the store's readers only when something they read moved. */
function settle(store: IndexStatusStore, ready: { notes: number; revision: number }): void {
  const now = store.getState();
  if (now.phase === 'ready' && now.notes === ready.notes && now.revision === ready.revision) return;
  store.setState({ phase: 'ready', message: null, ...ready });
}

/**
 * Keeps the index in step with the vault.
 *
 * It is opened and brought up to date whenever a vault is opened. Rebuilding
 * throws the database away and starts again, which is the check that nothing
 * depends on it surviving. Only those two say the index is building; a
 * refresh after a change keeps it ready while it runs (#238).
 */
export function useIndex({
  ports,
  vaultKey,
  activity,
  changes,
  ownWrites,
}: {
  ports: IndexPorts;
  vaultKey: string | null;
  /** Where a rebuild, and a failure, is said (U-28). */
  activity: ActivityLog;
  /** Where every refresh says which notes it found added, changed or removed (P28-03). */
  changes: NoteChanges;
  /** Told of every sync that finished, so the echo of a write it took in is not refreshed for again (#254). */
  ownWrites?: Pick<OwnWrites, 'lastWrite' | 'refreshed'>;
}): {
  /** The open vault's status. What only needs part of it reads `store` through a selector. */
  status: IndexStatus;
  store: IndexStatusStore;
  progress: IndexProgressStore;
  /**
   * Resolves true once the index holds the files as they were when it was
   * asked, false when it does not. A `quiet` refresh — the watcher's — moves
   * the revision only when it found a change. `recheck` names notes to read
   * again whatever their time and size (#245).
   */
  refresh: (options?: { quiet?: boolean; recheck?: readonly string[] }) => Promise<boolean>;
  rebuild: () => Promise<boolean>;
  /**
   * Resolves true once the index holds every change that has asked for a
   * refresh so far, without reading the vault again to get there: it waits
   * for the last build or refresh already asked, and asks for one only when
   * none has been, or the last did not hold the files.
   */
  catchUp: () => Promise<boolean>;
  /** Resolves once every refresh of the open vault asked so far has run, asking none itself. */
  settled: () => Promise<void>;
} {
  const [store] = useState(createIndexStatusStore);
  const [progress] = useState(createIndexProgress);
  const revision = useRef(0);
  // Read by every syncer this hook has made, so one left from a vault since
  // closed drops what is still queued on it instead of reading the new vault.
  const open = useRef(vaultKey);
  open.current = vaultKey;
  const counted = useMemo(() => countingPublishes(changes), [changes]);
  const syncer = useMemo(
    () =>
      createIndexSyncer({
        fs: ports.fs,
        index: ports.index,
        markdown: ports.markdown,
        ...(ports.deriver !== undefined && { deriver: ports.deriver }),
        activity,
        changes: counted,
        openVault: () => open.current,
        ...(ownWrites !== undefined && { ownWrites }),
      }),
    [ports.fs, ports.index, ports.markdown, ports.deriver, activity, counted, ownWrites],
  );

  const run = useCallback(
    async ({ vault, request, last, current }: QueuedSync): Promise<boolean> => {
      if (open.current !== vault) return false;
      const { fromScratch, quiet, recheck } = request;
      const building = fromScratch || store.getState().vault !== vault;
      if (building) {
        progress.set(NOT_STARTED);
        store.setState({ vault, phase: 'building', message: null });
      }
      const publishedBefore = counted.published();
      try {
        const stats = await syncer.sync({
          vault,
          fromScratch,
          ...(recheck !== undefined && { recheck }),
          onProgress: (done, total) => {
            // A build caught by a switch may report once more before it stops.
            if (current()) progress.set({ done, total });
          },
        });
        // Dropped: the vault closed while it waited, and the one open now has its own.
        if (stats === null) return false;
        const found = counted.published() > publishedBefore;
        if (building || found || !quiet) revision.current += 1;
        // Not "ready" while a sync queued behind this one is still to write:
        // whatever reads the index on "ready" would read it half written (#135).
        if (last()) settle(store, { notes: stats.notes, revision: revision.current });
        return true;
      } catch (cause) {
        // Moved for every failure, so the window hears each edit the index could not take.
        revision.current += 1;
        // A sync still to come has the last word; this failure is in the Activity log.
        if (last()) {
          store.setState({ phase: 'failed', message: message(cause), revision: revision.current });
        }
        return false;
      }
    },
    [syncer, store, progress, counted],
  );
  // One queue for the window, so asks made across a re-render still join one another.
  const latestRun = useRef(run);
  latestRun.current = run;
  const [queue] = useState(() => createSyncQueue((sync) => latestRun.current(sync)));

  /** The last sync asked of the open vault: it settles after every one asked before it. */
  const lastAsked = useRef<{ vault: string; held: Promise<boolean> } | null>(null);
  const ask = useCallback(
    (request: SyncRequest) => {
      if (vaultKey === null || open.current !== vaultKey) return Promise.resolve(false);
      const held = queue.ask(vaultKey, request);
      lastAsked.current = { vault: vaultKey, held };
      return held;
    },
    [queue, vaultKey],
  );

  useEffect(() => {
    if (vaultKey === null) {
      store.setState({ vault: null, phase: 'idle', message: null });
      return;
    }
    void ask({ fromScratch: false, quiet: false });
  }, [vaultKey, ask, store]);

  const catchUp = useCallback(async () => {
    const last = lastAsked.current;
    if (last?.vault === vaultKey && (await last.held)) return true;
    return ask({ fromScratch: false, quiet: false });
  }, [vaultKey, ask]);

  return {
    status: useIndexStatus(store, vaultKey),
    store,
    progress,
    refresh: useCallback(
      (options?: { quiet?: boolean; recheck?: readonly string[] }) =>
        ask({
          fromScratch: false,
          quiet: options?.quiet === true,
          ...(options?.recheck !== undefined &&
            options.recheck.length > 0 && { recheck: options.recheck }),
        }),
      [ask],
    ),
    rebuild: useCallback(() => ask({ fromScratch: true, quiet: false }), [ask]),
    catchUp,
    settled: useCallback(async () => {
      const last = lastAsked.current;
      if (last?.vault === vaultKey) await last.held;
    }, [vaultKey]),
  };
}
