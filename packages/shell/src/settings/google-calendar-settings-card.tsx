import { GoogleCalendarSettings } from '@dfai/ui';
import type { GoogleCalendarSettingState } from './use-google-calendar.ts';

/** Settings → Google Calendar, wired to the host's sign-in and the vault's settings. */
export function GoogleCalendarSettingsCard({ setting }: { setting: GoogleCalendarSettingState }) {
  return (
    <GoogleCalendarSettings
      view={setting.view}
      onConnect={setting.connect}
      onCancel={setting.cancel}
      onDisconnect={setting.disconnect}
      onChoose={setting.choose}
      onCreate={setting.create}
      meetings={setting.meetings}
      blocks={setting.blocks}
    />
  );
}
