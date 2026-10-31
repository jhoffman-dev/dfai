import { memo } from 'react';
import { KindleSettings } from '@dfai/ui';
import type { KindleController } from '../kindle/use-kindle-sync.ts';

/**
 * Settings → Kindle, wired to the window's Kindle sync. Drawn again only
 * when the controller changes, which it does only when Kindle's state does.
 */
export const KindleSettingsCard = memo(function KindleSettingsCard({
  kindle,
}: {
  kindle: KindleController;
}) {
  return (
    <KindleSettings
      view={kindle.view}
      onConnect={kindle.connect}
      onSyncNow={kindle.syncNow}
      onDisconnect={kindle.disconnect}
      onIntoVault={kindle.setIntoVault}
    />
  );
});
