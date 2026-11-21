import type { VaultDeps } from './vault-deps.ts';

export interface OpenedVault {
  /** Visible notes, as the tree and search show them. */
  readonly noteCount: number;
  /** Why the favourites file could not be read, or null. */
  readonly favoritesProblem: string | null;
}

/** Loads every file this device holds into the session and builds the index. No network. */
export async function openVault(deps: VaultDeps): Promise<OpenedVault> {
  deps.session.load(await deps.store.list());
  return {
    noteCount: deps.session.index.paths().length,
    favoritesProblem: deps.session.favoritesProblem,
  };
}
