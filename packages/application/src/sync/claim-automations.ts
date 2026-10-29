import {
  claimedSettings,
  namesThisMac,
  type ClaimingMac,
  type ClaimOutcome,
  type ClaimRefusal,
} from '@dfai/domain';
import type { MarkdownPort } from '../notes/ports.ts';
import type { SettingsWriter } from '../settings/index.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { loadSyncSettings } from './sync-settings.ts';

/** Thrown inside the writer's turn when another vault opened first: nothing is written. */
class VaultClosedBeforeClaim extends Error {}

/**
 * Names this Mac as the one that runs the vault's automations (ADR-0035
 * part 2, ADR-0025): the one way `automationsMac` changes once sync is set
 * up, from "Process here" on the Inbox and from Settings → Sync alike. It
 * writes through the vault's one settings writer, and the other Mac reads
 * the new value on its next sync and stands down.
 *
 * `refusal`, when given, is asked before anything is read and again right
 * before the write, as the gates are (ADR-0035 part 4): "Process here" is
 * refused while sync is paused, failing or has not pulled since launch or
 * wake. Settings → Sync is the person's own move (ADR-0025) and passes none.
 *
 * Settings that cannot be read write nothing. Settings that already name
 * this Mac, by id, write nothing: a Mac renamed since is still the one
 * named. A vault switched away from before the write writes nothing.
 */
export async function claimAutomations({
  ports,
  mac,
  syncs,
  refusal,
  stillOpen,
}: {
  ports: {
    readonly settings: Pick<SettingsWriter, 'update'>;
    readonly fs: Pick<VaultFsPort, 'readNotes'>;
    readonly markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
  };
  mac: ClaimingMac;
  /** Whether the vault syncs: then a missing settings note is unreadable. */
  syncs: boolean;
  refusal?: () => Promise<ClaimRefusal | null>;
  /** Whether the vault the claim is for is still the one open. */
  stillOpen: () => boolean;
}): Promise<ClaimOutcome> {
  const asked = async () => (refusal === undefined ? null : refusal());
  const refusedBefore = await asked();
  if (refusedBefore !== null) return { kind: 'refused', why: refusedBefore };
  let named: string | null;
  let was: string | null;
  try {
    ({ automationsMac: named, automationsMacName: was } = await loadSyncSettings({
      ...ports,
      required: syncs,
    }));
  } catch {
    // Nothing written, and said by the banner: the vault's to fix, as the gates say.
    return { kind: 'unreadable' };
  }
  if (namesThisMac(named, mac)) return { kind: 'already-named' };
  const refusedNow = await asked();
  if (refusedNow !== null) return { kind: 'refused', why: refusedNow };
  return write({ settings: ports.settings, mac, stillOpen, was });
}

/** The claim's write, in the writer's turn: abandoned there if another vault opened while it queued. */
async function write({
  settings,
  mac,
  stillOpen,
  was,
}: {
  settings: Pick<SettingsWriter, 'update'>;
  mac: ClaimingMac;
  stillOpen: () => boolean;
  /** The name the settings kept for the Mac named before. */
  was: string | null;
}): Promise<ClaimOutcome> {
  if (!stillOpen()) return { kind: 'vault-closed' };
  try {
    await settings.update(() => {
      if (!stillOpen()) throw new VaultClosedBeforeClaim();
      return claimedSettings(mac);
    });
  } catch (cause) {
    if (cause instanceof VaultClosedBeforeClaim) return { kind: 'vault-closed' };
    return { kind: 'write-failed', reason: cause instanceof Error ? cause.message : String(cause) };
  }
  return { kind: 'claimed', was };
}
