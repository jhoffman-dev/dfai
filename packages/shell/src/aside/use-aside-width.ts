import { useStore } from 'zustand';
import { typeShownAt, type ObjectType, type SavedViewSummary } from '@dfai/domain';
import { ASIDE_WIDTH, ASIDE_WIDTH_TYPE } from '@dfai/ui';
import { activePlace, type WorkspaceStore } from '../workspace/workspace-store.ts';
import type { AsideStore } from './aside-store.ts';

/**
 * The aside's width at hand (plan question 18): 340 while its Type tab is
 * chosen and offered — the focused tab shows a type the vault defines, on
 * its page or a view — else 300. What `RightSidebar` marks `.aside--type`,
 * read for the window's fold. The tab is read first, so on any other tab
 * a move between pages draws nothing here.
 */
export function useAsideWidth({
  aside,
  workspace,
  savedViews,
  types,
}: {
  aside: AsideStore;
  workspace: WorkspaceStore;
  savedViews: readonly Pick<SavedViewSummary, 'path' | 'type'>[];
  types: readonly Pick<ObjectType, 'name'>[];
}): number {
  const typeTab = useStore(aside, (state) => state.tab === 'type');
  const offered = useStore(workspace, (state) => {
    if (!typeTab) return false;
    const name = typeShownAt(activePlace(state.workspace), savedViews);
    return types.some((type) => type.name === name);
  });
  return offered ? ASIDE_WIDTH_TYPE : ASIDE_WIDTH;
}
