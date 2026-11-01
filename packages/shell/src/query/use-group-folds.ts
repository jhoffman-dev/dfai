import { useCallback, useMemo, useState } from 'react';
import type { GroupFolds, GroupFoldStore } from '@dfai/ui';

/**
 * The groups folded shut in the view a pane shows, remembered per view on
 * this Mac. Opening another view reads that view's folds; folding one writes
 * them back at once.
 */
export function useGroupFolds({
  store,
  view,
}: {
  store: GroupFoldStore;
  /** Which view's folds: its vault and path, so two vaults' views never share. */
  view: string;
}): GroupFolds {
  const [folds, setFolds] = useState(() => ({ view, ids: store.read(view) }));
  // Another view opened in the pane: its own folds, read as it is drawn.
  const current = folds.view === view ? folds : { view, ids: store.read(view) };
  if (current !== folds) setFolds(current);

  const collapsed = useMemo(() => new Set(current.ids), [current.ids]);
  // Read from the store, not from what this pane last drew: the same view open
  // in another pane may have folded a group since, and that fold must survive.
  const onToggle = useCallback(
    (id: string) => {
      const stored = store.read(view);
      const ids = stored.includes(id) ? stored.filter((shut) => shut !== id) : [...stored, id];
      store.write(view, ids);
      setFolds({ view, ids });
    },
    [store, view],
  );
  return useMemo(() => ({ collapsed, onToggle }), [collapsed, onToggle]);
}
