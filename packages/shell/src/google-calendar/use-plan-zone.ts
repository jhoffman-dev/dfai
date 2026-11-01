import { storedPlanZone } from '@dfai/domain';
import type { MarkdownPort, VaultFsPort } from '@dfai/application';
import { useVaultSettingsRead } from '../settings/use-vault-settings-read.ts';

/** The plan zone as the window has read it so far. */
export interface PlanZoneRead {
  /** Whether the settings read has answered, worked or failed: until it has, no zone is known either way. */
  readonly read: boolean;
  /** The zone kept; null when none is, the note cannot be read, or it has not been read yet. */
  readonly zone: string | null;
}

/**
 * The plan zone the open vault's settings keep (#587, ADR-0046): the clock
 * its event notes are on, which the morning brief and Today's meetings
 * read them on. None kept, or a note that cannot be read: the Mac's own
 * clock then. Not read yet is told apart, so the brief's schedule waits for
 * the read rather than count on the Mac's clock meanwhile. The same shared
 * read every setting makes, so asking it draws nothing more.
 */
export function usePlanZone({
  fs,
  markdown,
  vaultKey,
}: {
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
  vaultKey: string | null;
}): PlanZoneRead {
  const { settings, answer } = useVaultSettingsRead({ fs, markdown, vaultKey });
  return { read: answer !== null, zone: storedPlanZone(settings ?? {}) };
}
