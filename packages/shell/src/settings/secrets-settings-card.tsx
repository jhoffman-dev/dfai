import { SecretsSettings } from '@dfai/ui';
import type { SecretsSetting } from './use-secrets.ts';

/** Settings → Secrets, wired to the Keychain through the host. */
export function SecretsSettingsCard({ setting }: { setting: SecretsSetting }) {
  return (
    <SecretsSettings
      secrets={setting.rows}
      problem={setting.problem}
      pending={setting.pending}
      onSave={setting.save}
      onBind={setting.bind}
      onDelete={setting.remove}
    />
  );
}
