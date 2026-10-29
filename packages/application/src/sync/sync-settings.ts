import {
  AUTOMATIONS_MAC_KEY,
  AUTOMATIONS_MAC_NAME_KEY,
  automationsMacOf,
  pullIntervalMinutes,
  pushDelaySeconds,
  runsAutomationsHere,
  SYNC_INTERVAL_KEY,
  SYNC_PUSH_DELAY_KEY,
  type SettingsReading,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import { readVaultSettings, type SettingsWriter } from '../settings/index.ts';
import type { VaultFsPort } from '../vault/ports.ts';

/** What a synced vault's settings note says about syncing, the same on every Mac. */
export interface SyncSettings {
  /** How often to look for other Macs' changes. */
  readonly pullIntervalMinutes: number;
  /** How long after the last change to send it. */
  readonly pushDelaySeconds: number;
  /** The Mac that runs the automations, by its id; null when none is named. */
  readonly automationsMac: string | null;
  /** That Mac's name when it was named, to show. */
  readonly automationsMacName: string | null;
}

export async function loadSyncSettings(args: {
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
  /** Whether a missing settings note is refused as unreadable (see `readVaultSettings`). */
  required?: boolean;
}): Promise<SyncSettings> {
  return syncSettingsOf(await readVaultSettings(args));
}

/** What settings already read say about syncing. */
export function syncSettingsOf(settings: Readonly<Record<string, unknown>>): SyncSettings {
  return {
    pullIntervalMinutes: pullIntervalMinutes(settings[SYNC_INTERVAL_KEY]),
    pushDelaySeconds: pushDelaySeconds(settings[SYNC_PUSH_DELAY_KEY]),
    automationsMac: automationsMacOf(settings[AUTOMATIONS_MAC_KEY]),
    automationsMacName: automationsMacOf(settings[AUTOMATIONS_MAC_NAME_KEY]),
  };
}

/**
 * What the vault's settings note, read from the file now, says of who runs
 * the automations (ADR-0035 part 4): read once each pull has completed, so a
 * claim another Mac made is seen before anything acts on what the pull
 * brought, and again right before each act. In a vault that syncs the file
 * must be there; one missing, or that cannot be read — its frontmatter, its
 * permissions, bytes that are not UTF-8 — is `unreadable`, and nothing runs.
 */
export async function automationsSettingsReading({
  thisMacId,
  syncs,
  ...files
}: {
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
  thisMacId: string;
  /** Whether the vault syncs: then a missing settings note is unreadable, not silent. */
  syncs: boolean;
}): Promise<SettingsReading> {
  let automationsMac: string | null;
  try {
    ({ automationsMac } = await loadSyncSettings({ ...files, required: syncs }));
  } catch {
    // Said by the gates, in Activity, once: what could not be read is the vault's to fix.
    return 'unreadable';
  }
  return runsAutomationsHere({ automationsMac, thisMacId })
    ? 'names-this-mac'
    : 'names-another-mac';
}

/** What Settings → Sync changes of the shared timing. Who runs the automations is the claim's alone (`claimAutomations`). */
export type SyncTimingChanges = Partial<
  Pick<SyncSettings, 'pullIntervalMinutes' | 'pushDelaySeconds'>
>;

export async function saveSyncSettings({
  settings,
  changes,
}: {
  settings: SettingsWriter;
  changes: SyncTimingChanges;
}): Promise<void> {
  await settings.save({
    ...(changes.pullIntervalMinutes !== undefined && {
      [SYNC_INTERVAL_KEY]: pullIntervalMinutes(changes.pullIntervalMinutes),
    }),
    ...(changes.pushDelaySeconds !== undefined && {
      [SYNC_PUSH_DELAY_KEY]: pushDelaySeconds(changes.pushDelaySeconds),
    }),
  });
}
