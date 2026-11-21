import type { Clock } from '../ports/index.ts';
import type { SyncNow, SyncResult } from './sync-now.ts';

/** Timers, injected so tests move time by hand (`setTimeout` in the app). */
export interface SyncTimers {
  /** Runs `run` once, `ms` from now; the returned function cancels it. */
  after(ms: number, run: () => void): () => void;
}

/**
 * What sync is doing, for the status line. `offline`: GitHub could not be
 * reached. `needs-sign-in`: the token was refused. `error`: anything else,
 * said in `message`. Each lasts until a sync succeeds.
 */
export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'needs-sign-in' | 'error';

export interface SyncStatus {
  readonly phase: SyncPhase;
  /** Conflict copies the last successful sync made (each is a file in the vault to merge). */
  readonly conflicts: number;
  readonly lastSyncedAt: Date | null;
  /** Why the last sync failed, or null when it did not. Never holds the token. */
  readonly message: string | null;
}

export interface SyncScheduler {
  /** Syncs now, then pulls every `pullEveryMs`. */
  start(): Promise<void>;
  /** Cancels every timer. A sync already running finishes. */
  stop(): void;
  /** A note changed here: push `pushDelayMs` after the last such call. */
  noteChanged(): void;
  /** Sync now: the app came back online, or into view. */
  wake(): Promise<void>;
  status(): SyncStatus;
  subscribe(listener: (status: SyncStatus) => void): () => void;
}

export interface SyncSchedulerDeps {
  readonly syncNow: SyncNow;
  readonly timers: SyncTimers;
  readonly clock: Clock;
  readonly pushDelayMs: number;
  readonly pullEveryMs: number;
  /**
   * Where an error thrown by a status listener goes, so one broken listener
   * cannot stop sync. Rethrown on its own (to the global error handler) by default.
   */
  readonly onListenerError?: (error: unknown) => void;
}

const rethrowApart = (error: unknown) =>
  queueMicrotask(() => {
    throw error;
  });

const NOT_YET: SyncStatus = { phase: 'idle', conflicts: 0, lastSyncedAt: null, message: null };

/**
 * When to sync: soon after typing stops, on an interval, and when woken.
 * Never two at once: a request while one runs is folded into one more run
 * after it.
 */
export function createSyncScheduler(deps: SyncSchedulerDeps): SyncScheduler {
  const listeners = new Set<(status: SyncStatus) => void>();
  let current = NOT_YET;
  let started = false;
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  let cancelPush: (() => void) | null = null;
  let cancelPull: (() => void) | null = null;

  const publish = (next: SyncStatus) => {
    current = next;
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (error) {
        (deps.onListenerError ?? rethrowApart)(error);
      }
    }
  };

  const armPull = () => {
    cancelPull?.();
    cancelPull = started ? deps.timers.after(deps.pullEveryMs, () => void sync()) : null;
  };

  const runOnce = async () => {
    publish({ ...current, phase: 'syncing' });
    publish(statusAfter(current, await settled(deps.syncNow), deps.clock));
  };

  const sync = (): Promise<void> => {
    if (running !== null) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await runOnce();
        } while (again);
      } finally {
        running = null;
        armPull();
      }
    })();
    return running;
  };

  return {
    start() {
      started = true;
      stopped = false;
      return sync();
    },
    stop() {
      started = false;
      stopped = true;
      cancelPush?.();
      cancelPull?.();
      cancelPush = cancelPull = null;
    },
    noteChanged() {
      if (stopped) return;
      cancelPush?.();
      cancelPush = deps.timers.after(deps.pushDelayMs, () => {
        cancelPush = null;
        void sync();
      });
    },
    wake: () => sync(),
    status: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The sync's result; a sync that throws (a bug) is a failed one, so the scheduler keeps going. */
async function settled(syncNow: SyncNow): Promise<SyncResult> {
  try {
    return await syncNow();
  } catch (error) {
    return {
      kind: 'failed',
      reason: 'error',
      message: error instanceof Error ? error.message : 'Sync failed.',
    };
  }
}

const PHASES = {
  auth: 'needs-sign-in',
  unreachable: 'offline',
  moved: 'idle',
  'branch-missing': 'error',
  'remote-changed': 'error',
  error: 'error',
} as const;

function statusAfter(before: SyncStatus, result: SyncResult, clock: Clock): SyncStatus {
  if (result.kind === 'synced')
    return {
      phase: 'idle',
      conflicts: result.conflicts.length,
      lastSyncedAt: clock.now(),
      message: null,
    };
  return { ...before, phase: PHASES[result.reason], message: result.message };
}
