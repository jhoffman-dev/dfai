import { useCallback } from 'react';
import { searchRepositories } from '@dfai/domain';
import { SyncSettings } from '@dfai/ui';
import { syncSettingsView } from './sync-view.ts';
import type { SyncController } from './use-sync.ts';

/** Settings → Sync, wired to the vault's sync. */
export function SyncSettingsCard({ sync, vaultName }: { sync: SyncController; vaultName: string }) {
  const { repositories } = sync;
  const findRepositories = useCallback(
    (query: string) =>
      repositories.kind === 'ready' ? searchRepositories(repositories.repositories, query) : [],
    [repositories],
  );
  return (
    <SyncSettings
      view={syncSettingsView(sync, vaultName)}
      onCreate={(name) => sync.setUp({ kind: 'new-github', name })}
      onConnect={(url) => sync.setUp({ kind: 'existing', url })}
      onSyncNow={sync.syncNow}
      onPushDelay={sync.setPushDelay}
      onPullInterval={sync.setPullInterval}
      onPause={sync.setPaused}
      onClaimAutomations={sync.claimAutomations}
      onLoadRepositories={sync.loadRepositories}
      findRepositories={findRepositories}
    />
  );
}
