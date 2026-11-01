import { useCallback, useState } from 'react';
import {
  openVaultFromGitHub,
  type GitFoldersPort,
  type VaultLocation,
  type VaultLocationStore,
} from '@dfai/application';
import { errorMessage } from '../query/error-message.ts';

/**
 * "Open a vault from GitHub" (U-29): the dialog's state, and the clone that
 * ends with the new vault open. What is refused, and where the clone lands,
 * is the use-case's.
 */
export function useOpenFromGitHub({
  folders,
  store,
  openVault,
  beforeSwitch,
  showVault,
  onDone,
}: {
  folders: GitFoldersPort;
  store: VaultLocationStore;
  /** The open vault's root; null with none open. */
  openVault: string | null;
  beforeSwitch: () => Promise<void>;
  showVault: (location: VaultLocation) => void;
  /** Closes the dialog once the vault is open. */
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const open = useCallback(
    (url: string) => {
      setBusy(true);
      setProblem(null);
      openVaultFromGitHub({ folders, store, url, openVault, beforeSwitch })
        .then((location) => {
          if (location === null) return;
          showVault(location);
          onDone();
        })
        .catch((cause: unknown) => setProblem(errorMessage(cause)))
        .finally(() => setBusy(false));
    },
    [folders, store, openVault, beforeSwitch, showVault, onDone],
  );
  const reset = useCallback(() => setProblem(null), []);
  return { busy, problem, open, reset };
}
