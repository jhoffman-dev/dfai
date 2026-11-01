import { useCallback, useMemo } from 'react';
import {
  saveSidebarOrder,
  sidebarOrderOf,
  type ActivityLog,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import type { SidebarSectionId } from '@dfai/domain';
import type { SectionOrder } from '@dfai/ui';
import { useVaultSetting } from '../settings/use-vault-setting.ts';
import { vaultSettingsWriter } from '../settings/vault-settings-writer.ts';

/**
 * The order the sidebar's sections were dragged into, as the vault's settings
 * note keeps it, a way to change it, why the last change was not saved, and
 * why the note cannot be read.
 *
 * The sections cannot be moved until the saved order has been read: a move
 * made before would be made on the default order, and saved over the chosen one.
 */
export function useSidebarOrder({
  fs,
  markdown,
  vaultKey,
  activity,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  vaultKey: string | null;
  /** Where a save that fails is recorded. */
  activity: Pick<ActivityLog, 'inOpenVault'>;
}): { order: SectionOrder; problem: string | null; unreadable: string | null } {
  const store = useCallback(
    (order: readonly SidebarSectionId[]) =>
      saveSidebarOrder({ settings: vaultSettingsWriter({ fs, markdown }), order }),
    [fs, markdown],
  );
  const { value, loaded, save, problem, unreadable } = useVaultSetting({
    fs,
    markdown,
    parse: sidebarOrderOf,
    store,
    vaultKey,
    activity,
  });
  const order = useMemo(
    () => (loaded ? { saved: value, onChange: save } : { saved: value }),
    [loaded, value, save],
  );
  return { order, problem, unreadable };
}
