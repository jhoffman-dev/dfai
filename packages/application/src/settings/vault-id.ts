import { newVaultId, vaultIdOf, VAULT_ID_KEY, VAULT_SETTINGS_PATH } from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import type { Rng } from '../ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { readVaultSettings } from './vault-settings.ts';

const unreadable = () =>
  new Error(
    `${VAULT_ID_KEY} in ${VAULT_SETTINGS_PATH} is not text, so no new block can be given an event id until it is fixed or removed.`,
  );

/**
 * The settings change that gives the vault its own id when it has none:
 * nothing when it has one, or one that is not text (never overwritten).
 */
export function vaultIdChange(
  current: Readonly<Record<string, unknown>>,
  rng: Pick<Rng, 'next'>,
): Readonly<Record<string, unknown>> {
  return vaultIdOf(current).kind === 'none' ? { [VAULT_ID_KEY]: newVaultId(() => rng.next()) } : {};
}

/**
 * The vault's own id, as its settings hold it; null when they hold none. Only
 * read, never made here: an id one Mac made and git has not carried would
 * have two writers draw two event ids for one block. A value that is not
 * text is refused.
 */
export async function readVaultId({
  fs,
  markdown,
}: {
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
}): Promise<string | null> {
  const reading = vaultIdOf(await readVaultSettings({ fs, markdown }));
  if (reading.kind === 'unreadable') throw unreadable();
  return reading.kind === 'id' ? reading.id : null;
}
