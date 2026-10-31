import type { ComponentProps } from 'react';
import { activeSidebarPageOf, type VaultPath } from '@dfai/domain';
import { Sidebar } from '@dfai/ui';
import { useFocusedPlace, type WorkspaceStore } from './workspace-store.ts';

/**
 * The sidebar with its active mark drawn from the store: the one page the
 * focused pane's shown tab is on. A tab switch draws the sidebar and not the
 * app around it; everything else the sidebar is handed is the app's.
 */
export function ActiveSidebar({
  store,
  viewOwner,
  ...sidebar
}: Omit<ComponentProps<typeof Sidebar>, 'active'> & {
  store: WorkspaceStore;
  /** The type a note is one of the views of, or null: a view marks its type. */
  viewOwner: (path: VaultPath) => string | null;
}) {
  const place = useFocusedPlace(store);
  return <Sidebar {...sidebar} active={activeSidebarPageOf(place, viewOwner)} />;
}
