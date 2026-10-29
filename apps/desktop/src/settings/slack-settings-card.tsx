import type { SlackPort } from '@dfai/application';
import { SlackSettings } from '@dfai/ui';
import { useSlackSettings } from './use-slack-settings.ts';

/** Settings → Slack, wired to the host's token; it asks only while drawn. */
export function SlackSettingsCard({ port, vault }: { port: SlackPort; vault: string | null }) {
  const setting = useSlackSettings({ port, vault });
  return (
    <SlackSettings
      view={setting.view}
      onConnect={setting.connect}
      onDisconnect={setting.disconnect}
    />
  );
}
