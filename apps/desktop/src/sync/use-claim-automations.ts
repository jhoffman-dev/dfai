import { useCallback, useEffect, useRef, useState } from 'react';
import {
  claimProblem,
  claimRefusalLine,
  claimReport,
  claimSharedReport,
  type ClaimingMac,
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
  /** Whether the settings, as drawn, name this Mac: by a claim here or any other way. */
  readonly named: boolean;
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  readonly vaultKey: string | null;
  readonly thisMac: ThisMac | null;
  /** Whether the open vault's sync is set up here. */
  readonly syncs: boolean;
  /** Whether sync is paused on this Mac: the claim is written and left for the next sync. */
  readonly paused: boolean;
  /** How this Mac's sync of the vault stands at the moment it is asked, not as last drawn. */
  readonly phaseNow: () => SyncPhase;
  /** The gates' answer to whether this Mac may claim now (ADR-0035 part 2). */
  readonly claimRefusal: (vault: string, phase: SyncPhase) => Promise<ClaimRefusal | null>;
  /** Tells the gates a claim is written here and not yet pushed: they stay shut until GitHub has it. */
  readonly claimed: (vault: string, was: string | null) => void;
  /** Whether the gates know a claim not yet pushed, now. */
  readonly claimUnsharedNow: (vault: string) => boolean;
  /** The same, as last drawn: a sync that pushes the claim draws it false. */
  readonly claimUnshared: boolean;
  readonly exclusive: Exclusive;
  readonly activity: Pick<ActivityLog, 'inVault'>;
  /** Reads the settings note again, so the claim shows at once. */
  readonly readAgain: () => Promise<void>;
  /** A sync now: it pushes the claim and pulls, after which the named Mac's catch-ups run. */
  readonly run: () => Promise<SyncReport | null>;
}

const MAC_UNKNOWN = claimRefusalLine('mac-unknown');

/** A claim written here and not yet pushed: the Mac it was taken from, by its name. */
interface Pending {
  readonly vault: string;
  readonly mac: ClaimingMac;
  readonly was: string | null;
}

/** Something said of one vault, so it is never shown for another. */
interface Said<T> {
  readonly vault: string;
  readonly value: T;
}

export interface ClaimAutomations {
  /** Settings → Sync: the person's own move (ADR-0025), not gated. */
  readonly claimAutomations: () => void;
  /** "Process here": refused while the gates say a claim could not be shared. */
  readonly processHere: () => Promise<ClaimOutcome>;
  /** Whether a claim is waiting for its turn or being written. */
  readonly claiming: boolean;
  /** Why the last Settings → Sync claim named no Mac; null when it did. */
  readonly problem: string | null;
  /** While the claim is set here and not yet shared: the name of the Mac it was taken from. */
  readonly pending: { readonly was: string | null } | null;
}

/**
 * The two ways this Mac takes the vault's automations (ADR-0035 part 2):
 * Settings → Sync and "Process here". Both are the one claim
 * (`claimAutomations`), made in the vault's git turn so no pull lands while
 * it is decided, then synced at once unless sync is paused. Until a sync has
 * pushed it, the gates stay shut and the claim is said as set here but not
 * yet shared; once one has, Activity says this Mac runs the automations.
 */
export function useClaimAutomations(options: ClaimAutomationsOptions): ClaimAutomations {
  const latest = useRef(options);
  latest.current = options;
  const { vaultKey, claimUnshared } = options;
  const [claiming, setClaiming] = useState<Said<number> | null>(null);
  const [problem, setProblem] = useState<Said<string> | null>(null);
  const clearProblem = useCallback(
    (vault: string) => setProblem((was) => (was?.vault === vault ? null : was)),
    [],
  );
  // Once this Mac's id is read, "not read yet" no longer holds; once it is named, by any path, none does.
  const macKnown = options.thisMac !== null;
  const { named } = options;
  useEffect(() => {
    if (named) setProblem(null);
    else if (macKnown) setProblem((was) => (was?.value === MAC_UNKNOWN ? null : was));
  }, [macKnown, named]);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingNow = useRef<Pending | null>(null);
  // The vaults this session claimed in: their claims say "now runs" themselves.
  const claimedHere = useRef(new Set<string>());

  /** Says, once, that the claim has reached GitHub. */
  const sayShared = useCallback((claim: Pending) => {
    // Only for the vault open now: one left is not synced, and its claim waits there (#630 attack).
    if (pendingNow.current !== claim || latest.current.vaultKey !== claim.vault) return;
    pendingNow.current = null;
    setPending(null);
    latest.current.activity.inVault(claim.vault).record(claimSharedReport(claim.mac));
  }, []);
  const settled = useCallback(
    (claim: Pending) => {
      if (!latest.current.claimUnsharedNow(claim.vault)) sayShared(claim);
    },
    [sayShared],
  );
  // A later sync, after a paused or failed one, pushes it too.
  useEffect(() => {
    if (pending !== null && !claimUnshared) settled(pending);
  }, [pending, claimUnshared, settled]);
  useSharedAfterRestart({ vaultKey, claimUnshared, claimedHere, latest });

  const afterClaim = useCallback(
    async (vault: string, mac: ClaimingMac, outcome: ClaimOutcome) => {
      const report = claimReport(outcome);
      // Named now, by this claim or before it: the card's old problem no longer holds.
      if (outcome.kind === 'claimed' || outcome.kind === 'already-named') clearProblem(vault);
      if (outcome.kind !== 'claimed') {
        if (report !== null) latest.current.activity.inVault(vault).record(report);
        return;
      }
      if (latest.current.vaultKey !== vault) return;
      if (!latest.current.syncs) {
        latest.current.activity.inVault(vault).record(claimSharedReport(mac));
        await latest.current.readAgain();
        return;
      }
      const claim: Pending = { vault, mac, was: outcome.was };
      claimedHere.current.add(vault);
      latest.current.claimed(vault, outcome.was);
      pendingNow.current = claim;
      setPending(claim);
      if (report !== null) latest.current.activity.inVault(vault).record(report);
      await latest.current.readAgain();
      if (latest.current.paused || latest.current.vaultKey !== vault) return;
      await latest.current.run();
      settled(claim);
    },
    [settled, clearProblem],
  );

  const claim = useCallback(
    async (gated: boolean): Promise<ClaimOutcome> => {
      const { vaultKey: vault, thisMac: mac, exclusive } = latest.current;
      if (vault === null || !exclusive.open()) return { kind: 'vault-closed' };
      if (mac === null) return { kind: 'refused', why: 'mac-unknown' };
      const { fs, markdown } = latest.current;
      const stillOpen = () => latest.current.vaultKey === vault;
      const outcome = await exclusive.start('claim', () =>
        claimAutomations({
          ports: { settings: vaultSettingsWriter({ fs, markdown }), fs, markdown },
          mac,
          syncs: latest.current.syncs,
          stillOpen,
          ...(gated && {
            refusal: () => latest.current.claimRefusal(vault, latest.current.phaseNow()),
          }),
        }),
      );
      await afterClaim(vault, mac, outcome);
      return outcome;
    },
    [afterClaim],
  );

  /** Settings → Sync's claim, busy while it waits its turn, saying on the card why it named no Mac. */
  const claimFromSettings = useCallback(() => {
    const vault = latest.current.vaultKey;
    if (vault === null) return;
    const busy = (by: number) =>
      setClaiming((was) => {
        const count = (was?.vault === vault ? was.value : 0) + by;
        return count === 0 ? null : { vault, value: count };
      });
    busy(1);
    setProblem(null);
    void claim(false)
      .then(
        (outcome) => claimProblem(outcome),
        (cause: unknown) =>
          claimProblem({
            kind: 'write-failed',
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      )
      .then((said) => {
        busy(-1);
        if (said !== null) setProblem({ vault, value: said });
      });
  }, [claim]);

  return {
    claimAutomations: claimFromSettings,
    processHere: useCallback(() => claim(true), [claim]),
    claiming: claiming?.vault === vaultKey,
    problem: problem?.vault === vaultKey ? problem.value : null,
    pending: pending?.vault === vaultKey ? pending : null,
  };
}

/**
 * A claim this session did not make — written before a restart — found
 * unshared by git and then seen shared, in the same vault: said once, as a
 * claim made here is (#630 review). A claim this session made says it itself.
 */
function useSharedAfterRestart({
  vaultKey,
  claimUnshared,
  claimedHere,
  latest,
}: {
  vaultKey: string | null;
  claimUnshared: boolean;
  claimedHere: { readonly current: ReadonlySet<string> };
  latest: { readonly current: ClaimAutomationsOptions };
}) {
  const seen = useRef<{ vault: string | null; unshared: boolean }>({
    vault: null,
    unshared: false,
  });
  useEffect(() => {
    const was = seen.current;
    seen.current = { vault: vaultKey, unshared: claimUnshared };
    if (vaultKey === null || was.vault !== vaultKey || !was.unshared || claimUnshared) return;
    const mac = latest.current.thisMac;
    if (claimedHere.current.has(vaultKey) || mac === null) return;
    latest.current.activity.inVault(vaultKey).record(claimSharedReport(mac));
  }, [vaultKey, claimUnshared, claimedHere, latest]);
}
