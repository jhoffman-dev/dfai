import { useStore } from 'zustand';
import { indexKeyOf, type IndexStatusStore } from './index-status-store.ts';

/**
 * The index's key as the store holds it, drawn on every move: what each
 * scoped key reads when the news reaches it (`useScopedIndexKey`). Test
 * support, for tests of how the key itself moves.
 */
export function useHeldIndexKey(store: IndexStatusStore, open: string | null): string {
  return useStore(store, (state) => indexKeyOf(state, open));
}
