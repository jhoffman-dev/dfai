import { useCallback, useSyncExternalStore } from 'react';
import { activeTabOf, type TabId, type VaultPath } from '@dfai/domain';
import type { WorkspaceStore } from '../workspace/workspace-store.ts';
import { asideShown, focusedRowOf, type AsideStore } from './aside-store.ts';

/**
 * Whether the aside is showing this tab's note's properties, so the note's
 * body need not: the aside is on screen on Properties, this tab is the
 * focused pane's shown one, and no row of a table in it has taken over. One
 * snapshot over both stores, so a tab is drawn only as its own answer flips —
 * never for a pane focus or a row while the aside is shut.
 */
export function usePropertiesInAside({
  aside,
  workspace,
  tab,
  path,
}: {
  aside: AsideStore;
  workspace: WorkspaceStore;
  tab: TabId;
  path: VaultPath | null;
}): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const stopAside = aside.subscribe(onChange);
      const stopWorkspace = workspace.subscribe(onChange);
      return () => {
        stopAside();
        stopWorkspace();
      };
    },
    [aside, workspace],
  );
  return useSyncExternalStore(subscribe, () => {
    const state = aside.getState();
    if (!asideShown(state) || state.tab !== 'properties') return false;
    if (activeTabOf(workspace.getState().workspace).id !== tab) return false;
    return focusedRowOf(state, { tab, within: path }) === null;
  });
}
