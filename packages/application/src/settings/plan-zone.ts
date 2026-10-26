import { planZoneChange, storedPlanZone, type PlanZoneSource } from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import type { SettingsWriter } from './settings-writer.ts';
import { readVaultSettings, UnreadableSettingsError } from './vault-settings.ts';

type SettingsReads = {
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
};

/**
 * The plan zone the vault's settings keep (#587, ADR-0046); null when they
 * keep none. A settings note that cannot be read keeps none either: the
 * zone only says which clock event notes are on, and the Mac's is the
 * nearest one known, as it was before any zone was kept. Every setting in
 * that note is refused elsewhere, where the person can fix it.
 */
export async function readPlanZone(reads: SettingsReads): Promise<string | null> {
  try {
    return storedPlanZone(await readVaultSettings(reads));
  } catch (cause) {
    // Safe to read as none: see above. A fault that is not the note's own still rises.
    if (cause instanceof UnreadableSettingsError) return null;
    throw cause;
  }
}

/**
 * Keeps the zone a sync learned in the vault's settings, written only when it
 * changes, so a sync every 15 minutes never rewrites the file. Read first, so
 * the settled case writes nothing; then the change is worked out again at
 * the writer's turn, against the settings as they stand then.
 */
export async function keepPlanZone({
  settings,
  fs,
  markdown,
  learned,
  from,
}: SettingsReads & {
  settings: SettingsWriter;
  learned: string | null;
  from: PlanZoneSource;
}): Promise<boolean> {
  const current = await readVaultSettings({ fs, markdown });
  if (Object.keys(planZoneChange({ settings: current, learned, from })).length === 0) return false;
  await settings.update((latest) => planZoneChange({ settings: latest, learned, from }));
  return true;
}
