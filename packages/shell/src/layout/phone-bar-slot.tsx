import type { PhoneScreen } from '@dfai/domain';
import { PhoneBar } from '@dfai/ui';
import { useFocusedPlace, type WorkspaceStore } from '../workspace/workspace-store.ts';

/**
 * The phone's bar (#672), reading where the focused pane is so the bar can
 * mark Today as the screen showing. Read here rather than in the window, so a
 * tab switched or a note opened draws the bar and not the whole app.
 */
export function PhoneBarSlot({
  screens,
  workspace,
  onOpen,
}: {
  screens: readonly PhoneScreen[];
  workspace: WorkspaceStore;
  onOpen: (screen: PhoneScreen) => void;
}) {
  const place = useFocusedPlace(workspace);
  return (
    <PhoneBar
      screens={screens}
      current={place?.kind === 'today' ? 'today' : null}
      onOpen={onOpen}
    />
  );
}
