import type { StrandedEdit } from '@dfai/domain';
import type { StrandedEditStore } from '../stranded-edits.ts';

/**
 * A store that outlives the hooks using it, for tests: mounting a fresh hook
 * on the same one is the stand-in for quitting and starting again.
 */
export function memoryStrandedStore({ refuseWrites = false } = {}) {
  const vaults = new Map<string, Map<string, StrandedEdit>>();
  const entries = (vaultKey: string) => {
    const found = vaults.get(vaultKey) ?? new Map<string, StrandedEdit>();
    vaults.set(vaultKey, found);
    return found;
  };
  const store: StrandedEditStore = {
    read: (vaultKey) => [...entries(vaultKey).values()],
    put: ({ vaultKey, edit }) => {
      if (refuseWrites) return false;
      entries(vaultKey).set(edit.path, edit);
      return true;
    },
    remove: ({ vaultKey, path }) => void entries(vaultKey).delete(path),
  };
  return { store, stored: (vaultKey: string) => [...entries(vaultKey).values()] };
}
