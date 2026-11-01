import { useCallback, useMemo, useReducer } from 'react';
import type { KindleVaultChoices } from '@dfai/application';

/**
 * Whether Kindle sync may write into the open vault (ADR-0044), and the
 * person's switch for it. Off until turned on, and off with no vault open.
 */
export function useKindleVaultChoice(
  choices: KindleVaultChoices,
  vaultKey: string | null,
): { readonly intoVault: boolean; readonly setIntoVault: (on: boolean) => void } {
  // The choice is kept outside React; a change counts, so the next read is of the new one.
  const [changes, changed] = useReducer((count: number) => count + 1, 0);
  const intoVault = useMemo(
    () => vaultKey !== null && choices.isOn(vaultKey),
    // `changes` is not read: it is what makes a new choice be read.
    [choices, vaultKey, changes],
  );
  const setIntoVault = useCallback(
    (on: boolean) => {
      if (vaultKey === null) return;
      choices.set(vaultKey, on);
      changed();
    },
    [choices, vaultKey],
  );
  return { intoVault, setIntoVault };
}
