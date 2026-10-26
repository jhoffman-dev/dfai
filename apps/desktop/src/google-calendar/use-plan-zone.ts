import { storedPlanZone } from '@dfai/domain';
import type { MarkdownPort, VaultFsPort } from '@dfai/application';
import { useVaultSettingsRead } from '../settings/use-vault-settings-read.ts';

/**
 * The plan zone the open vault's settings keep (#587, ADR-0046): the clock
 * its event notes are on, which the morning brief and Today's meetings
 * read them on. Null when none is kept: the Mac's own clock then. The same
 * shared read every setting makes, so asking it draws nothing more.
 */
export function usePlanZone({
  fs,
  markdown,
  vaultKey,
}: {
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
  vaultKey: string | null;
}): string | null {
  const { settings } = useVaultSettingsRead({ fs, markdown, vaultKey });
  return storedPlanZone(settings ?? {});
}
