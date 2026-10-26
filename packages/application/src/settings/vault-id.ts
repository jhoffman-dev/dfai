import {
  newVaultId,
  vaultIdOf,
  VAULT_ID_KEY,
  VAULT_SETTINGS_PATH,
  type VaultIdReading,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import type { Rng } from '../ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import type { SettingsWriter } from './settings-writer.ts';
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
 * The vault's own id, from its settings; made once, from `rng`, and written
 * there through the vault's one settings writer when it has none, so it
 * travels with the vault as every setting does. A value there that is not
 * text is refused rather than overwritten. `beforeWrite` is asked just
 * before the settings are written, so a caller that was stopped writes
 * nothing.
 */
export async function ensureVaultId({
  fs,
  markdown,
  settings,
  rng,
  beforeWrite = () => undefined,
}: {
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
  settings: SettingsWriter;
  rng: Pick<Rng, 'next'>;
  beforeWrite?: () => void;
}): Promise<string> {
  const first = vaultIdOf(await readVaultSettings({ fs, markdown }));
  if (first.kind === 'id') return first.id;
  if (first.kind === 'unreadable') throw unreadable();
  beforeWrite();
  const settled: { reading: VaultIdReading } = { reading: first };
  await settings.update((current) => {
    const change = vaultIdChange(current, rng);
    // Another write may have given it one meanwhile: that one is kept.
    settled.reading = vaultIdOf({ ...current, ...change });
    return change;
  });
  if (settled.reading.kind === 'id') return settled.reading.id;
  throw unreadable();
}
