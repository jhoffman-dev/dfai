import { useCallback, useRef } from 'react';
import {
  claimReport,
  type ClaimOutcome,
  type ClaimRefusal,
  type SyncPhase,
  type SyncReport,
} from '@dfai/domain';
import {
  claimAutomations,
  type ActivityLog,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import { vaultSettingsWriter } from '../settings/vault-settings-writer.ts';
import type { Exclusive, ThisMac } from './use-sync-runs.ts';

export interface ClaimAutomationsOptions {
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly vaultKey: string | null;
  readonly thisMac: ThisMac | null;
  /** Whether the open vault's sync is set up here. */
  readonly syncs: boolean;
  /** How this Mac's sync of the vault last stood. */
  readonly phase: SyncPhase;
  /** The gates' answer to whether this Mac may claim now (ADR-0035 part 2). */
  readonly claimRefusal: (vault: string, phase: SyncPhase) => Promise<ClaimRefusal | null>;
  readonly exclusive: Exclusive;
  readonly activity: Pick<ActivityLog, 'inVault'>;
  /** Reads the settings note again, so the claim shows at once. */
  readonly readAgain: () => Promise<void>;
  /** A sync now: it pushes the claim and pulls, after which the named Mac's catch-ups run. */
  readonly run: () => Promise<SyncReport | null>;
}

/**
 * The two ways this Mac takes the vault's automations (ADR-0035 part 2):
 * Settings → Sync, the person's own move (ADR-0025), and "Process here" on
 * the Inbox, refused while the gates say a claim could not be shared. Both
 * are the one claim (`claimAutomations`), made in the vault's git turn so no
 * pull lands while it is decided, then synced at once: the sooner the claim
 * reaches GitHub, the shorter the time both Macs believe they are named.
 */
export function useClaimAutomations(options: ClaimAutomationsOptions) {
  const latest = useRef(options);
  latest.current = options;
  const claim = useCallback(async (gated: boolean): Promise<ClaimOutcome> => {
    const { vaultKey: vault, thisMac: mac, exclusive } = latest.current;
    if (vault === null || !exclusive.open()) return { kind: 'vault-closed' };
    // The Mac's id is read as the app starts; until it is, nothing names it.
    if (mac === null) return { kind: 'refused', why: 'no-pull' };
    const { fs, markdown } = latest.current;
    const stillOpen = () => latest.current.vaultKey === vault;
    const outcome = await exclusive.start('claim', () =>
      claimAutomations({
        ports: { settings: vaultSettingsWriter({ fs, markdown }), fs, markdown },
        mac,
        syncs: latest.current.syncs,
        stillOpen,
        ...(gated && {
          refusal: () => latest.current.claimRefusal(vault, latest.current.phase),
        }),
      }),
    );
    const report = claimReport(outcome, mac);
    if (report !== null) latest.current.activity.inVault(vault).record(report);
    if (outcome.kind === 'claimed' && stillOpen()) {
      await latest.current.readAgain();
      void latest.current.run();
    }
    return outcome;
  }, []);
  return {
    claimAutomations: useCallback(() => void claim(false), [claim]),
    processHere: useCallback(() => claim(true), [claim]),
  };
}
