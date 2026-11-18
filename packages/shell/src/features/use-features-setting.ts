import { useCallback, useMemo } from 'react';
import {
  featuresOffOf,
  saveFeatureSwitch,
  type ActivityLog,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import { FEATURES, featuresOffAfter, isFeatureId, type FeatureId } from '@dfai/domain';
import type { FeatureRow } from '@dfai/ui';
import { useVaultSetting } from '../settings/use-vault-setting.ts';
import { vaultSettingsWriter } from '../settings/vault-settings-writer.ts';
import { featureRows } from './feature-rows.ts';

const NONE_OFF: readonly FeatureId[] = [];

/** The features switched off in this vault (#901), and the way to flip one. */
export interface FeaturesSetting {
  /** What is switched off: none until the settings are read, and while they cannot be. */
  readonly off: readonly FeatureId[];
  /** Whether `off` is what this vault's settings hold; the switches wait for it. */
  readonly loaded: boolean;
  /**
   * Whether this vault's settings note has answered at all, read or found
   * unreadable: until then nobody knows what is off, so a feature's page waits.
   */
  readonly answered: boolean;
  /** Why the last switch was not saved. */
  readonly problem: string | null;
  readonly switchFeature: (change: { readonly id: FeatureId; readonly on: boolean }) => void;
  /** Settings → Features' rows, the same array while `off` is. */
  readonly rows: readonly FeatureRow[];
  /** A row's switch flipped: as `switchFeature`, for an id Settings hands back as a string. */
  readonly onSwitch: (change: { readonly id: string; readonly on: boolean }) => void;
}

/**
 * The features switched off, as the vault's settings note keeps them, read in
 * the window's one read of that note, so they settle in the same commit as the
 * sidebar's order. A switch shows at once and is written behind it, one key's
 * change through the vault's one settings writer.
 */
export function useFeaturesSetting({
  fs,
  markdown,
  vaultKey,
  activity,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  vaultKey: string | null;
  /** Where a switch that fails to save is recorded. */
  activity: Pick<ActivityLog, 'inOpenVault'>;
}): FeaturesSetting {
  const store = useCallback(
    async (next: readonly FeatureId[], previous: readonly FeatureId[] | null) => {
      const settings = vaultSettingsWriter({ fs, markdown });
      for (const { id } of FEATURES) {
        const on = !next.includes(id);
        if (on !== !(previous ?? NONE_OFF).includes(id)) {
          await saveFeatureSwitch({ settings, id, on });
        }
      }
    },
    [fs, markdown],
  );
  const { value, loaded, answered, save, problem } = useVaultSetting({
    fs,
    markdown,
    parse: featuresOffOf,
    store,
    vaultKey,
    activity,
  });
  const off = value ?? NONE_OFF;
  const switchFeature = useCallback(
    (change: { readonly id: FeatureId; readonly on: boolean }) =>
      save(featuresOffAfter(off, change)),
    [off, save],
  );
  const onSwitch = useCallback(
    ({ id, on }: { readonly id: string; readonly on: boolean }) => {
      if (isFeatureId(id)) switchFeature({ id, on });
    },
    [switchFeature],
  );
  const rows = useMemo(() => featureRows(off), [off]);
  // One object while nothing in it changes: Settings → Features draws again only then.
  return useMemo(
    () => ({ off, loaded, answered, problem, switchFeature, rows, onSwitch }),
    [off, loaded, answered, problem, switchFeature, rows, onSwitch],
  );
}
