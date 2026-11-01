import type { SlackPort } from '@dfai/application';
import { SETTINGS_SECTIONS, SettingsSectionWhenShown, SlackSettings } from '@dfai/ui';
import { useSlackSettings } from './use-slack-settings.ts';

/**
 * Settings → Slack, wired to the host's token. Its body, and the host's
 * `slack_status`, wait until the section is shown, so opening Settings to
 * change something else asks the host nothing about Slack (#105).
 */
export function SlackSettingsCard({ port, vault }: { port: SlackPort; vault: string | null }) {
  return (
    <SettingsSectionWhenShown section={SETTINGS_SECTIONS.slack}>
      <SlackSettingsBody port={port} vault={vault} />
    </SettingsSectionWhenShown>
  );
}

function SlackSettingsBody({ port, vault }: { port: SlackPort; vault: string | null }) {
  const setting = useSlackSettings({ port, vault });
  return (
    <SlackSettings
      view={setting.view}
      onConnect={setting.connect}
      onDisconnect={setting.disconnect}
    />
  );
}
