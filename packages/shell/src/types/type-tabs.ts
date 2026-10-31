import { typePageTabs, type ObjectType, type ViewTab } from '@dfai/domain';
import type { SidebarCatalog } from '@dfai/application';

/**
 * A type's tabs as its page shows them, read from the same catalogue its
 * tabs' writes are asked against — so the default table's tab wears the name
 * the file is written under.
 */
export function typeTabsShown(
  catalog: Pick<SidebarCatalog, 'savedViews' | 'takenViewPaths'>,
  type: ObjectType,
): ViewTab[] {
  return typePageTabs({ views: catalog.savedViews, type, takenPaths: catalog.takenViewPaths });
}
