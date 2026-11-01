import { createStore, type StoreApi } from 'zustand';
import type { LastChange, Settling } from './use-today.ts';

/** What every Today tab draws from: the rows being written, and the last change to take back. */
export interface TodayWritesState {
  readonly settling: Settling;
  readonly last: LastChange | null;
}

/**
 * Today's writes in flight, held by the window for the vault rather than by
 * the tab that ticked (tab-model.md, PR B): a tab switched back to, or a
 * second Today in a split, draws a ticked task as settling rather than as
 * still to do, and keeps the undo. The hook reads the store by selector.
 */
export interface TodayWrites {
  readonly store: StoreApi<TodayWritesState>;
  /** Counts the reads begun by any tab, so a row can tell one made after its write from one already under way. */
  readonly reads: { begun: number };
}

/** Nothing being written, of no vault. */
export const NOTHING_SETTLING: Settling = {
  index: null,
  vaultKey: null,
  rows: new Map(),
  changes: new Map(),
  known: new Map(),
};

export function createTodayWrites(): TodayWrites {
  return {
    store: createStore<TodayWritesState>()(() => ({ settling: NOTHING_SETTLING, last: null })),
    reads: { begun: 0 },
  };
}
