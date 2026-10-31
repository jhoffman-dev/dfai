import type { KindleVaultChoices } from '@dfai/application';

const KEY = 'atlas.kindle-vaults';

/** The vaults kept as turned on, or none when what is kept is not a list of them. */
function vaultsOf(kept: string | null): string[] {
  if (kept === null) return [];
  const parsed: unknown = JSON.parse(kept);
  return Array.isArray(parsed)
    ? parsed.filter((vault): vault is string => typeof vault === 'string')
    : [];
}

function read(): string[] {
  try {
    return vaultsOf(window.localStorage.getItem(KEY));
  } catch {
    // Safe to ignore: no vault reads as turned on, which keeps Kindle sync out of every vault.
    return [];
  }
}

/**
 * Where this Mac keeps which vaults Kindle sync writes into (ADR-0044): the
 * vaults' roots, in the app's own storage and not in the vault, since the
 * choice is this Mac's and the vault syncs. A vault is off until turned on.
 *
 * Every access is guarded: the accessor throws where site data is blocked,
 * and a kept list may have been edited by hand. Either way it reads as none
 * turned on, the safe way to be wrong.
 */
export const browserKindleVaults: KindleVaultChoices = {
  isOn: (vault) => read().includes(vault),
  set: (vault, on) => {
    const others = read().filter((kept) => kept !== vault);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(on ? [...others, vault] : others));
    } catch {
      // Safe to ignore: the choice reads as before, so a vault stays as it was.
    }
  },
};
