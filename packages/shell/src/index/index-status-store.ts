import { useMemo } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

/**
 * Where the index is for the vault it was last synced for. `building` is only
 * the first sync of a vault after it opens, and a rebuild: an incremental
 * refresh never leaves `ready`, so nothing that waits on ready pauses or
 * blanks for one (#238).
 */
export type IndexPhase = 'idle' | 'building' | 'ready' | 'failed';

export interface IndexStatusState {
  /** The vault this status describes; another vault open means its sync has not begun. */
  readonly vault: string | null;
  readonly phase: IndexPhase;
  readonly notes: number;
  /**
   * Moves when the index has news for its readers: a sync published changes,
   * a build finished, a refresh an own write asked for settled, or a sync
   * failed. A note count alone does not move when a note is edited rather
   * than added.
   */
  readonly revision: number;
  /** Why the last sync failed, while `phase` is `failed`. */
  readonly message: string | null;
}

export type IndexStatusStore = StoreApi<IndexStatusState>;

/** The status as the window's status line, the progress pill and Settings show it. */
export type IndexStatus =
  | { readonly kind: 'idle' }
  /** Being built. How far it has got is the progress store's to say, so `done` and `total` stay 0 here. */
  | { readonly kind: 'working'; readonly done: number; readonly total: number }
  | { readonly kind: 'ready'; readonly notes: number; readonly revision: number }
  | { readonly kind: 'failed'; readonly message: string };

export function createIndexStatusStore(): IndexStatusStore {
  return createStore<IndexStatusState>()(() => ({
    vault: null,
    phase: 'idle',
    notes: 0,
    revision: 0,
    message: null,
  }));
}

/**
 * The phase as the open vault sees it. A vault open that the store has not
 * synced yet is building: its first sync is about to start, and what the
 * store holds is the last vault's.
 */
function phaseFor(state: IndexStatusState, open: string | null): IndexPhase {
  if (open === null) return 'idle';
  return state.vault === open ? state.phase : 'building';
}

/** Whether the open vault's index is ready to read. */
export function useIndexReady(store: IndexStatusStore, open: string | null): boolean {
  return useStore(store, (state) => open !== null && phaseFor(state, open) === 'ready');
}

export function useIndexPhase(store: IndexStatusStore, open: string | null): IndexPhase {
  return useStore(store, (state) => phaseFor(state, open));
}

/** Why the open vault's index failed, or null while it has not. */
export function useIndexFailure(store: IndexStatusStore, open: string | null): string | null {
  return useStore(store, (state) =>
    phaseFor(state, open) === 'failed' ? (state.message ?? '') : null,
  );
}

/**
 * The index's key as the store holds it now: `ready:<revision>` once ready,
 * and `failed:<revision>` while failing — a refresh that fails again still
 * moves it, so an edit made while the index is broken still counts toward a
 * push. Otherwise the phase. No reader re-runs on it directly: each reads it
 * through a scoped key (`useScopedIndexKey`), which the index's news moves
 * only when it touched what that reader is made from (ADR-0040, #327).
 */
export function indexKeyOf(state: IndexStatusState, open: string | null): string {
  const phase = phaseFor(state, open);
  return phase === 'ready' || phase === 'failed' ? `${phase}:${state.revision}` : phase;
}

/** The open vault's status, for what shows it. */
export function useIndexStatus(store: IndexStatusStore, open: string | null): IndexStatus {
  // useShallow: a new object per call would loop useSyncExternalStore.
  const { phase, notes, revision, message } = useStore(
    store,
    useShallow((state) => ({
      phase: phaseFor(state, open),
      notes: state.notes,
      revision: state.revision,
      message: state.message,
    })),
  );
  return useMemo(
    () => summaryOf({ phase, notes, revision, message }),
    [phase, notes, revision, message],
  );
}

function summaryOf({
  phase,
  notes,
  revision,
  message,
}: Pick<IndexStatusState, 'phase' | 'notes' | 'revision' | 'message'>): IndexStatus {
  switch (phase) {
    case 'idle':
      return { kind: 'idle' };
    case 'building':
      return { kind: 'working', done: 0, total: 0 };
    case 'ready':
      return { kind: 'ready', notes, revision };
    case 'failed':
      return { kind: 'failed', message: message ?? '' };
  }
}
