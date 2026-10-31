import { useEffect, useEffectEvent, useRef } from 'react';
import { viewSpecsFor, type DefinedType, type IndexPort } from '@dfai/application';
import type { IndexStatusStore } from '../index/index-status-store.ts';

/**
 * The SQL view behind each type, rebuilt when the definitions change — adding
 * a property to a type makes a column appear — and when the index is ready
 * after a build, which made the database afresh without them. A rebuild that
 * failed is tried again when the index next has news (its revision moves),
 * heard from the status store without drawing the window (#326).
 * Nothing else rebuilds them: `types` is the same array until a definition
 * changes (#259).
 */
export function useSqlViews({
  index,
  types,
  ready,
  status,
}: {
  index: Pick<IndexPort, 'rebuildViews'>;
  types: readonly DefinedType[];
  ready: boolean;
  /** The index's status, whose revision moves when the index has news. */
  status: IndexStatusStore;
}): void {
  const failed = useRef(false);
  const rebuild = useEffectEvent(() => {
    failed.current = false;
    if (!ready || types.length === 0) return;
    index.rebuildViews(viewSpecsFor(types)).catch(() => {
      // A view that cannot be built shows as a failing query until the retry.
      failed.current = true;
    });
  });

  useEffect(() => rebuild(), [index, types, ready]);
  // Only a failed rebuild listens for news; one that worked waits for new definitions.
  useEffect(
    () =>
      status.subscribe((now, before) => {
        if (now.revision !== before.revision && failed.current) rebuild();
      }),
    [status],
  );
}
