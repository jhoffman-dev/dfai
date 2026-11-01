import type { StrandedEdit, VaultPath } from '@dfai/domain';

/**
 * Kept work the store refused, by the vault it belongs to. Memory is its only
 * copy, so it is held for every vault and not only the open one: a switch
 * away and back is not a quit, and work for a vault that is not open has
 * nowhere else to be.
 */
export class UnstoredWork {
  private readonly byVault = new Map<string, Map<VaultPath, StrandedEdit>>();

  /** Records whether the store took this work: if not, memory holds it. */
  record({ vault, edit, stored }: { vault: string; edit: StrandedEdit; stored: boolean }): void {
    if (stored) this.release({ vault, path: edit.path });
    else this.byVault.set(vault, new Map(this.byVault.get(vault)).set(edit.path, edit));
  }

  release({ vault, path }: { vault: string; path: VaultPath }): void {
    const held = this.byVault.get(vault);
    held?.delete(path);
    if (held?.size === 0) this.byVault.delete(vault);
  }

  in(vault: string | null): readonly StrandedEdit[] {
    return vault === null ? [] : [...(this.byVault.get(vault)?.values() ?? [])];
  }

  /** What is held for each vault other than `vault`. */
  elsewhere(vault: string | null): readonly (readonly [string, readonly StrandedEdit[]])[] {
    return [...this.byVault]
      .filter(([held]) => held !== vault)
      .map(([held, edits]) => [held, [...edits.values()]] as const);
  }
}
