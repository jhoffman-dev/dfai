import { useMemo } from 'react';
import { QueryObserver, useQueryClient } from '@tanstack/react-query';
import type { ReadScope } from '@dfai/application';
import type { IndexStatusStore } from '../index/index-status-store.ts';
import { scopedIndexKeyQuery } from './use-scoped-index-key.ts';

/** Where a controller hears the index's news for what it is made from. */
export interface IndexNewsFeed {
  /** Calls `listener` each time such news arrives; returns how to stop. */
  subscribe(listener: () => void): () => void;
}

const SILENT: IndexNewsFeed = { subscribe: () => () => undefined };

/**
 * The index's news as a controller made from `scope` hears it (#326): the
 * same scoped query a pane's reader re-reads on (`useScopedIndexKey`), judged
 * by the same rule (`scopeTouched`, unknown news reaching it too), but heard
 * through a listener rather than drawn. A controller that only notes the news
 * — sync counting an edit — does not draw the window that holds it.
 *
 * `scope` is a named constant, so the feed stays the same while the vault does.
 */
export function useScopedIndexNews({
  status,
  vault,
  reader,
  scope,
}: {
  status: IndexStatusStore;
  vault: string | null;
  /** Which controller this is, for its query's key. */
  reader: string;
  scope: ReadScope;
}): IndexNewsFeed {
  const client = useQueryClient();
  return useMemo(() => {
    if (vault === null) return SILENT;
    const query = scopedIndexKeyQuery({ status, vault, reader: [reader], scope });
    return {
      subscribe(listener) {
        const observer = new QueryObserver(client, query);
        let last = observer.getCurrentResult().data;
        return observer.subscribe(({ data }) => {
          if (data === last) return;
          last = data;
          listener();
        });
      },
    };
  }, [client, status, vault, reader, scope]);
}
