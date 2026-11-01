import { useCallback } from 'react';
import { indexKeyOf, type IndexStatusStore } from '../index/index-status-store.ts';

/**
 * The index's own key for `vault` as it stands when asked, the same function
 * from one render to the next (#698): what a page's writes land at and its
 * reads are stamped with (`landedAsRefreshAsked`). Not the index's news — a
 * scoped key — which reaches a page a little after the index moves.
 */
export function useIndexKeyNow(status: IndexStatusStore, vault: string | null): () => string {
  return useCallback(() => indexKeyOf(status.getState(), vault), [status, vault]);
}
