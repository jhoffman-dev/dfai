import { GranolaSettings } from '@dfai/ui';
import type { GranolaSettingState } from './use-granola.ts';

/** Settings → Granola, wired to the host's key and the window's puller. */
export function GranolaSettingsCard({ setting }: { setting: GranolaSettingState }) {
  return (
    <GranolaSettings
      view={setting.view}
      onSaveKey={setting.saveKey}
      onForgetKey={setting.forgetKey}
      onSyncNow={setting.syncNow}
      onOpenNote={setting.openNote}
    />
  );
}
