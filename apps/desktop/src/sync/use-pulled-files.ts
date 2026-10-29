import { useMemo, useRef, useState } from 'react';
import {
  createFreshPullGate,
  type ActivityLog,
  type Arrival,
  type Clock,
  type FreshPullGate,
  type MarkdownPort,
  type SleepClockPort,
  type VaultFsPort,
} from '@dfai/application';
import type { PullStanding, WaitingCountGate } from '@dfai/domain';

/**
 * The gates of ADR-0035 part 4 for the open vault, as the meeting import and
 * a rule's Claude step ask them: whether this Mac may act on what sync
 * brought in, right before each act and each write.
 */
export interface PulledFilesGate {
  /** The open vault's last pull; changes as each pull starts and ends, for whatever waits on one. */
  readonly standing: PullStanding | null;
  /** Whether this Mac may act on the vault's files now: on these notes, or on one file as it arrived. */
  readonly acts: (vault: string, arrival?: Arrival) => Promise<boolean>;
  /** Whether a Mac that is not named may count the meetings waiting for the one that is, and against which pull. */
  readonly countGate: (vault: string) => Promise<WaitingCountGate>;
  /** Whether the Mac has slept since the last pull started, as a reading since showed: the gates are shut though the standing is the same. */
  readonly slept: boolean;
  /** Whether sync is paused on this Mac for the open vault: the gates are shut, whatever the standing. */
  readonly paused: boolean;
}

/** What the vault's runs of git tell the gates. Each is a no-op for a vault no longer open. */
export type PullRecorder = Pick<
  FreshPullGate,
  'readAsleep' | 'started' | 'ended' | 'inspected' | 'inspectionFailed'
>;

/**
 * The one record, for the open vault, of the last pull this Mac completed,
 * and the gates that judge by it (`createFreshPullGate`). Kept for the vault
 * open now and forgotten when another opens. This wires the gate to the
 * window; what it decides is the application's and the domain's.
 */
export function usePulledFiles({
  vaultKey,
  sleepClock,
  fs,
  markdown,
  thisMacId,
  paused,
  pausedNow,
  clock,
  activity,
}: {
  vaultKey: string | null;
  sleepClock: SleepClockPort;
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
  /** This Mac's id; null until it is known. */
  thisMacId: string | null;
  /** Whether sync is paused on this Mac for a vault. */
  paused: (vault: string) => boolean;
  /** Whether sync is paused on this Mac for the open vault, as drawn now. */
  pausedNow: boolean;
  clock: Pick<Clock, 'now'>;
  activity: Pick<ActivityLog, 'inVault'>;
}): {
  gate: PulledFilesGate;
  pulls: PullRecorder;
  claimRefusal: FreshPullGate['claimRefusal'];
} {
  const latest = useRef({ sleepClock, fs, markdown, thisMacId, paused, clock, activity });
  latest.current = { sleepClock, fs, markdown, thisMacId, paused, clock, activity };
  // Bumped as the standing changes, so whatever waits on a pull renders again.
  const [, setChanges] = useState(0);
  const [fresh] = useState(() =>
    createFreshPullGate({
      ports: {
        sleepClock: {
          asleepMs: () =>
            latest.current.sleepClock.asleepMs().catch((cause: unknown) => {
              // Nothing then acts on a synced vault's files: the gate never guesses.
              console.error('How long this Mac has slept could not be read:', cause);
              throw cause;
            }),
        },
        fs: { readNotes: (paths) => latest.current.fs.readNotes(paths) },
        markdown: {
          frontmatterProperties: (frontmatter) =>
            latest.current.markdown.frontmatterProperties(frontmatter),
          frontmatterProblem: (frontmatter) =>
            latest.current.markdown.frontmatterProblem(frontmatter),
        },
        clock: { now: () => latest.current.clock.now() },
        activity: { inVault: (vault) => latest.current.activity.inVault(vault) },
      },
      here: {
        thisMacId: () => latest.current.thisMacId,
        paused: (vault) => latest.current.paused(vault),
      },
      onStanding: () => setChanges((count) => count + 1),
      onSlept: () => setChanges((count) => count + 1),
    }),
  );
  // From the render a vault opens on, the gates know only that vault, and nothing of it yet.
  fresh.opened(vaultKey);
  const standing = vaultKey === null ? null : fresh.standing(vaultKey);
  const slept = vaultKey !== null && fresh.sleptSincePull(vaultKey);
  const gate = useMemo(
    () => ({ standing, acts: fresh.acts, countGate: fresh.countGate, slept, paused: pausedNow }),
    [standing, fresh, slept, pausedNow],
  );
  return { gate, pulls: fresh, claimRefusal: fresh.claimRefusal };
}
