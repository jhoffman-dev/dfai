import { useCallback, useMemo, useState } from 'react';
import type { QueryPanelFold, QueryPanelFoldStore } from '@dfai/ui';

/**
 * Whether the query view a pane shows has its query folded to one line,
 * remembered per view on this Mac. A view not yet left either way opens
 * folded when its query is already written — the answer is what it is for —
 * and open when there is nothing to show yet. Opening another view reads
 * that view's fold; folding one writes it back at once.
 */
export function useQueryPanelFold({
  store,
  view,
  savedText,
}: {
  store: QueryPanelFoldStore;
  /** Which view's fold: its vault and path, so two vaults' views never share. */
  view: string;
  /**
   * The query as the view's file holds it: null while the file has not been
   * read yet, empty for a view with none yet.
   */
  savedText: string | null;
}): QueryPanelFold {
  // Settled once per view, the first time its query is known: saving a query
  // must not fold the builder under the hands editing it, so the saved text
  // counts only then. Null until there is something to settle on.
  const settle = () => ({
    view,
    collapsed: store.read(view) ?? (savedText === null ? null : savedText.trim() !== ''),
  });
  const [fold, setFold] = useState(settle);
  // Another view opened in the pane, or this one's file has now been read.
  const unsettled = fold.view !== view || (fold.collapsed === null && savedText !== null);
  const current = unsettled ? settle() : fold;
  if (current !== fold) setFold(current);

  // Nothing is drawn before the file is read, so "open" costs nothing then.
  const collapsed = current.collapsed ?? false;
  const onToggle = useCallback(() => {
    store.write(view, !collapsed);
    setFold({ view, collapsed: !collapsed });
  }, [store, view, collapsed]);
  return useMemo(() => ({ collapsed, onToggle }), [collapsed, onToggle]);
}
