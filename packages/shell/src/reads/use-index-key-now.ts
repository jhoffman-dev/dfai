import { useCallback, useRef } from 'react';

/**
 * The index's own key as it stands when asked, the same function from one
 * render to the next (#698): what a page's writes land at and its reads are
 * stamped with (`landedAsRefreshAsked`). `indexKey` — the index's news, which
 * reaches the page a little late — stands for it when the page is handed none.
 */
export function useIndexKeyNow(
  indexKeyNow: (() => string) | undefined,
  indexKey: string,
): () => string {
  const latest = useRef({ indexKeyNow, indexKey });
  latest.current = { indexKeyNow, indexKey };
  return useCallback(() => latest.current.indexKeyNow?.() ?? latest.current.indexKey, []);
}
