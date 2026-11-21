import {
  isConflictCopyPath,
  type SyncScheduler,
  type SyncStatus as SchedulerStatus,
  type VaultChange,
  type VaultSession,
} from '../application/index.ts';
import type { SyncControls, SyncStatus } from '../ui/sync/sync-status.ts';

/** The chip's status: the scheduler's phase, with the conflict copies still in the vault. */
export function chipStatus(status: SchedulerStatus, conflictCopies: number): SyncStatus {
  switch (status.phase) {
    case 'syncing':
      return { kind: 'syncing' };
    case 'offline':
      return { kind: 'offline' };
    case 'needs-sign-in':
      return { kind: 'needs-sign-in' };
    case 'error':
      return { kind: 'error', message: status.message ?? 'Sync stopped.' };
    case 'idle':
      return conflictCopies > 0
        ? { kind: 'conflicts', count: conflictCopies, lastSyncedAt: status.lastSyncedAt }
        : { kind: 'idle', lastSyncedAt: status.lastSyncedAt };
  }
}

/**
 * Whether a change was made here, by a person, and so is worth a push. Sync
 * writes what it pulls clean, so a pulled note never re-arms a push; a
 * delete or rename while a sync runs is that sync's own.
 */
function madeHere(change: VaultChange, session: VaultSession, syncing: boolean): boolean {
  if (change.kind === 'loaded') return false;
  if (change.kind === 'written') return session.file(change.path)?.dirty === true;
  return !syncing;
}

/**
 * Ties the scheduler to the session and the page: a local change asks for a
 * push, coming back online or into view syncs, and the conflict copies in
 * the vault are counted as they come and go (a lasting count, not the last
 * sync's). Returns the UI's `SyncControls` and the way to start.
 */
export function connectSync({
  scheduler,
  session,
  page,
}: {
  scheduler: SyncScheduler;
  session: VaultSession;
  /** The window, or a stand-in in tests: where `online` and `visibilitychange` are heard. */
  page: { addEventListener(type: string, listener: () => void): void; isVisible(): boolean };
}): SyncControls & { start(): void } {
  const listeners = new Set<() => void>();
  let copies = new Set(session.index.paths().filter(isConflictCopyPath));
  let status = chipStatus(scheduler.status(), copies.size);
  const publish = () => {
    status = chipStatus(scheduler.status(), copies.size);
    for (const listener of listeners) listener();
  };

  const recount = (change: VaultChange) => {
    const before = copies.size;
    if (change.kind === 'loaded')
      copies = new Set(session.index.paths().filter(isConflictCopyPath));
    else if (change.kind === 'deleted') copies.delete(change.path);
    else if (change.kind === 'renamed') {
      copies.delete(change.from);
      if (isConflictCopyPath(change.to)) copies.add(change.to);
    } else if (isConflictCopyPath(change.path) && session.index.has(change.path)) {
      copies.add(change.path);
    }
    if (copies.size !== before) publish();
  };

  session.subscribe((change) => {
    recount(change);
    if (madeHere(change, session, scheduler.status().phase === 'syncing')) {
      scheduler.noteChanged();
    }
  });
  scheduler.subscribe(publish);
  const wake = () => void scheduler.wake();
  page.addEventListener('online', wake);
  page.addEventListener('visibilitychange', () => {
    if (page.isVisible()) wake();
  });

  return {
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    syncNow: wake,
    start: () => void scheduler.start(),
  };
}
