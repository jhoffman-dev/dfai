import { useMemo } from 'react';
import { backPlace, forwardPlace, type NavigationPlace, type TabId } from '@dfai/domain';
import type { PageHistory } from '@dfai/ui';
import { goBackIn, goForwardIn, useTabHistory, type WorkspaceStore } from './workspace-store.ts';

/**
 * A tab's Back and Forward, for the bar of the page it shows: where each
 * leads, by name, and the step itself. The step goes through the pane, which
 * takes the focus, as a click in its bar does.
 */
export function useTabPageHistory({
  store,
  pane,
  id,
  nameOf,
}: {
  store: WorkspaceStore;
  pane: number;
  id: TabId;
  nameOf: (place: NavigationPlace) => string;
}): PageHistory {
  const history = useTabHistory(store, { pane, id });
  return useMemo(() => {
    const back = backPlace(history);
    const forward = forwardPlace(history);
    return {
      back: back === null ? null : nameOf(back),
      forward: forward === null ? null : nameOf(forward),
      onBack: () => goBackIn(store, pane),
      onForward: () => goForwardIn(store, pane),
    };
  }, [history, nameOf, store, pane]);
}
