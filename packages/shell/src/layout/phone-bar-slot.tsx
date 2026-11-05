import { phoneScreenShowing, type PhoneScreen, type VaultPath } from '@dfai/domain';
import { PhoneBar } from '@dfai/ui';
import { useFocusedPlace, type WorkspaceStore } from '../workspace/workspace-store.ts';

/**
 * The phone's bar (#672), reading where the focused pane is so the bar can
 * mark the screen showing (`phoneScreenShowing`, the domain). Read here rather
 * than in the window, so a tab switched or a note opened draws the bar and
 * not the whole app.
 */
export function PhoneBarSlot({
  screens,
  workspace,
  tasksShown,
  dailyNote,
  onOpen,
}: {
  screens: readonly PhoneScreen[];
  workspace: WorkspaceStore;
  /** Whether the vault has a task type, which is when Today is the Today page. */
  tasksShown: boolean;
  /** Today's note, once the bar has opened it; null until then. */
  dailyNote: VaultPath | null;
  onOpen: (screen: PhoneScreen) => void;
}) {
  const place = useFocusedPlace(workspace);
  return (
    <PhoneBar
      screens={screens}
      current={phoneScreenShowing(place, { tasksShown, dailyNote })}
      onOpen={onOpen}
    />
  );
}
