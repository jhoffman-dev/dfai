import {
  claimRefusal,
  githubSettingsUnreadableReport,
  freshPullVerdict,
  freshPullWaitReport,
  pullEndEffect,
  pulledSinceLastSleep,
  standingAfterPull,
  waitingCountGate,
  type ClaimRefusal,
  type FreshPullShut,
  type FreshPullVerdict,
  type PullEnd,
  type PullStanding,
  type SyncPhase,
  type WaitingCountGate,
} from '@dfai/domain';
import type { ActivityLog } from '../activity/ports.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { Clock } from '../ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { writtenAt } from '../vault/written-at.ts';
import { programWasMissing } from './git-steps.ts';
import type { SleepClockPort } from './ports.ts';
import type { AutomationsOnGitHub } from './automations-on-github.ts';
import { automationsSettingsNow } from './sync-settings.ts';
import { createUnsharedClaims } from './unshared-claims.ts';

/**
 * What is about to be acted on, for gate 1: one file, by when it was last
 * modified as it was first read — a write the act itself makes before its
 * last one does not move it — or notes, whose times are read now.
 */
export type Arrival = { readonly modifiedAt: number } | { readonly paths: readonly string[] };

/**
 * The gates of ADR-0035 part 4 for the open vault, and the one record they
 * judge by: what this session knows of its last pull. Sync tells it as each
 * pull and look starts and ends; the meeting import and a rule's Claude step
 * ask it right before each act and again before each write.
 */
export interface FreshPullGate {
  /** The vault's last pull as this session knows it; null when none has completed since it opened, or it is not open. */
  standing(vault: string): PullStanding | null;
  /** A vault opened (or none): what was known of the last one is forgotten, and it waits for a pull of its own. */
  opened(vault: string | null): void;
  /** Reads the host's sleep counter as a pull or a look starts; null when it cannot be read, which counts for nothing. */
  readAsleep(): Promise<number | null>;
  /** A pull of the vault has started: nothing acts on its files until it completes. */
  started(vault: string): void;
  /**
   * A sync or a look at GitHub has ended, having started at this reading of
   * the counter: see `pullEndEffect` for what that leaves known. A pull that
   * completed has the settings it left read now.
   */
  ended(vault: string, end: PullEnd, startedAsleepMs: number | null): Promise<void>;
  /**
   * How the vault stands with sync, as read when it opened or once it was
   * set up: one that does not sync has nothing to wait for; one that now
   * syncs waits for its first sync or look to complete.
   */
  inspected(vault: string, syncs: boolean): void;
  /**
   * Reading how the vault stands failed. When git is not on this Mac, the
   * vault cannot sync here, and is judged as one that does not; otherwise
   * nothing acts until a pull completes.
   */
  inspectionFailed(vault: string, cause: unknown): void;
  /** Whether this Mac may act on the vault's files now, and if not, why; says in Activity, once, a wait the person can end. */
  verdict(vault: string, arrival?: Arrival): Promise<FreshPullVerdict>;
  /** Whether this Mac may act on the vault's files now. */
  acts(vault: string, arrival?: Arrival): Promise<boolean>;
  /**
   * Whether a Mac that is not named may count the meetings waiting for the
   * one that is, and against which pull (ADR-0035 part 3): the same pull and
   * sleep gates, without asking whether this Mac is named.
   */
  countGate(vault: string): Promise<WaitingCountGate>;
  /**
   * Why this Mac may not claim the automations now, or null when it may
   * (ADR-0035 part 2): the pull and sleep gates and the pause, as for the
   * count, and `phase`, how its last sync or look ended.
   */
  claimRefusal(vault: string, phase: SyncPhase): Promise<ClaimRefusal | null>;
  /**
   * This Mac's claim of the automations is written in the vault's settings
   * here (#176): the gates stay shut until a sync completes, which pushed it.
   * A look that brings nothing completes a pull but pushes nothing.
   */
  claimed(vault: string, was?: string | null): void;
  /**
   * Whether this Mac's claim is written here and not on GitHub, as git showed
   * at the last pull or the claim's write showed since. Kept by vault.
   */
  claimUnshared(vault: string): boolean;
  /** The Mac a claim not yet shared was taken from, by the name GitHub's settings keep; null when not known. */
  claimWas(vault: string): string | null;
  /** Whether GitHub's settings, as the last pull read them, name this Mac: its claim is GitHub's. */
  namedOnGitHub(vault: string): boolean;
  /**
   * Whether a reading of the sleep counter since the vault's last pull shows
   * the Mac slept after that pull started: the gates are shut though the
   * standing is the same, until a pull started since completes.
   */
  sleptSincePull(vault: string): boolean;
}

export interface FreshPullGatePorts {
  readonly sleepClock: SleepClockPort;
  /** The open vault's files: its settings note, and the notes about to be acted on. */
  readonly fs: Pick<VaultFsPort, 'readNotes'>;
  readonly markdown: Pick<MarkdownPort, 'frontmatterProperties' | 'frontmatterProblem'>;
  readonly clock: Pick<Clock, 'now'>;
  readonly activity: Pick<ActivityLog, 'inVault'>;
  /**
   * The vault's settings on GitHub, as the last fetch left them (#630
   * attack): a claim is shared once they name this Mac. Null where there is
   * no git to read, as in tests of the other gates; then a completed sync is
   * taken to have pushed it.
   */
  readonly onGitHub: ((vault: string) => Promise<AutomationsOnGitHub>) | null;
}

/** What the gate reads of this Mac as it decides. */
export interface FreshPullHere {
  /** This Mac's id; null until it is known, when nothing acts. */
  readonly thisMacId: () => string | null;
  /** Whether sync is paused on this Mac for the vault. */
  readonly paused: (vault: string) => boolean;
}

/** One vault's record: whether it is known to sync, its standing, the wait last said in Activity, and a sleep seen since. */
interface VaultRecord {
  readonly vault: string | null;
  readonly syncs: boolean;
  readonly standing: PullStanding | null;
  readonly said: FreshPullShut | null;
  readonly slept: boolean;
}

const NOT_SYNCED: PullStanding = { kind: 'not-synced' };
const PULLING: PullStanding = { kind: 'pulling' };

/**
 * The gates for the vault open now (ADR-0035 part 4). Kept for that vault
 * and forgotten when another opens: a vault opened again waits for a pull of
 * its own. `onStanding` is told each time the standing changes, for whatever
 * waits on a pull. `onSlept` is told, once a pull, when a reading of the
 * sleep counter shows the Mac slept since that pull started, for whatever
 * shows a number only while the gates hold.
 */
export function createFreshPullGate({
  ports,
  here,
  onStanding = () => undefined,
  onSlept = () => undefined,
  onClaimUnshared = () => undefined,
}: {
  ports: FreshPullGatePorts;
  here: FreshPullHere;
  onStanding?: (vault: string, standing: PullStanding | null) => void;
  onSlept?: (vault: string) => void;
  /** Told when a look finds this Mac's claim not on GitHub: something must sync to push it. */
  onClaimUnshared?: (vault: string) => void;
}): FreshPullGate {
  const fresh = (vault: string | null): VaultRecord => ({
    vault,
    syncs: false,
    standing: null,
    said: null,
    slept: false,
  });
  let record: VaultRecord = fresh(null);

  const standingOf = (vault: string) => (record.vault === vault ? record.standing : null);
  const stand = (vault: string, standing: PullStanding | null) => {
    if (record.vault !== vault) return;
    record = { ...record, standing, slept: false };
    onStanding(vault, standing);
  };
  /** Notes a sleep since the last pull's start that this reading shows, telling it once. */
  const noteSleep = (asleepNowMs: number | null) => {
    const { vault, standing, slept } = record;
    if (vault === null || slept || standing?.kind !== 'pulled' || asleepNowMs === null) return;
    if (pulledSinceLastSleep({ standing, asleepNowMs })) return;
    record = { ...record, slept: true };
    onSlept(vault);
  };
  const readAsleep = async () => {
    const reading = await ports.sleepClock.asleepMs().catch(() => null);
    noteSleep(reading);
    return reading;
  };

  const settingsNow = async (standing: PullStanding | null) => {
    const thisMacId = here.thisMacId();
    // Read only where the standing lets the settings count: a vault that syncs must have them.
    if (thisMacId === null || (standing?.kind !== 'pulled' && standing?.kind !== 'not-synced')) {
      return null;
    }
    const syncs = standing.kind === 'pulled';
    return automationsSettingsNow({ ...ports, thisMacId, syncs });
  };

  /** The latest time the files about to be acted on were modified here; null for none, or none there to read. */
  const arrivedAt = async (arrival: Arrival | undefined): Promise<number | null> => {
    if (arrival === undefined) return null;
    if ('modifiedAt' in arrival) return arrival.modifiedAt;
    const notes = await ports.fs.readNotes(arrival.paths);
    if (notes.length === 0) return null;
    const known = notes.map(writtenAt).filter((time): time is number => time !== null);
    // A time the vault cannot tell is after every pull, so the gate stays shut (ADR-0053).
    return known.length < notes.length ? Number.POSITIVE_INFINITY : Math.max(...known);
  };

  /** Says in Activity a wait the person can end, once until the gates open again. */
  const say = (vault: string, verdict: FreshPullVerdict) => {
    if (record.vault !== vault) return;
    if (verdict.open) {
      record = { ...record, said: null };
      return;
    }
    const report = freshPullWaitReport(verdict.shut);
    if (report === null || record.said === verdict.shut) return;
    record = { ...record, said: verdict.shut };
    ports.activity.inVault(vault).record(report);
  };

  const claims = createUnsharedClaims({
    onGitHub: ports.onGitHub,
    // Told as whatever waits on the standing is: the banner says a claim not yet shared.
    onChange: (vault) => onStanding(vault, standingOf(vault)),
    onUnreadable: (vault) => ports.activity.inVault(vault).record(githubSettingsUnreadableReport()),
  });

  const pausedHere = (vault: string) =>
    record.vault === vault && record.syncs && here.paused(vault);

  const verdict = async (vault: string, arrival?: Arrival): Promise<FreshPullVerdict> => {
    const standing = standingOf(vault);
    const pulled = standing?.kind === 'pulled';
    const now = await settingsNow(standing);
    const thisMacId = here.thisMacId();
    const facts = {
      standing,
      settingsNow: now?.reading ?? null,
      asleepNowMs: pulled ? await readAsleep() : null,
      arrivedAt: pulled ? await arrivedAt(arrival) : null,
      paused: pausedHere(vault),
      claimUnshared:
        record.syncs && now !== null && thisMacId !== null && claims.judge(vault, now, thisMacId),
    };
    // A pull started or ended while the facts were read: they are judged against it instead.
    if (standingOf(vault) !== standing) return verdict(vault, arrival);
    const judged = freshPullVerdict(facts);
    say(vault, judged);
    return judged;
  };

  const countGate = async (vault: string): Promise<WaitingCountGate> => {
    const standing = standingOf(vault);
    const asleepNowMs = standing?.kind === 'pulled' ? await readAsleep() : null;
    // A pull started or ended while the counter was read: judged against it instead.
    if (standingOf(vault) !== standing) return countGate(vault);
    return waitingCountGate({ standing, asleepNowMs, paused: pausedHere(vault) });
  };

  const refusal = async (vault: string, phase: SyncPhase): Promise<ClaimRefusal | null> => {
    const standing = standingOf(vault);
    const asleepNowMs = standing?.kind === 'pulled' ? await readAsleep() : null;
    // As for the count: a pull started or ended meanwhile is judged instead.
    if (standingOf(vault) !== standing) return refusal(vault, phase);
    return claimRefusal({ standing, asleepNowMs, paused: pausedHere(vault), phase });
  };

  const inspected = (vault: string, syncs: boolean) => {
    if (record.vault !== vault) return;
    record = { ...record, syncs };
    if (!syncs) stand(vault, NOT_SYNCED);
    else if (record.standing?.kind === 'not-synced') stand(vault, null);
  };

  return {
    standing: standingOf,
    opened: (vault) => {
      if (record.vault !== vault) record = fresh(vault);
    },
    readAsleep,
    started: (vault) => stand(vault, PULLING),
    ended: async (vault, end, startedAsleepMs) => {
      const effect = pullEndEffect(end);
      if (effect === 'keeps') return;
      if (effect === 'voids') return stand(vault, null);
      const finishedAt = ports.clock.now();
      const thisMacId = here.thisMacId();
      if (startedAsleepMs === null || thisMacId === null) return stand(vault, null);
      const now = await automationsSettingsNow({ ...ports, thisMacId, syncs: true });
      // What git shows of a claim: here against GitHub, as this pull's fetch left it.
      const pushed = end.kind === 'synced';
      const unshared = await claims.learn({ vault, here: now, thisMacId, pushed });
      stand(vault, standingAfterPull({ startedAsleepMs, finishedAt, settings: now.reading }));
      if (unshared && !pushed && !here.paused(vault)) onClaimUnshared(vault);
    },
    inspected,
    inspectionFailed: (vault, cause) => {
      if (programWasMissing(cause)) inspected(vault, false);
    },
    verdict,
    acts: async (vault, arrival) => (await verdict(vault, arrival)).open,
    countGate,
    claimRefusal: refusal,
    claimed: (vault, was = null) => {
      if (record.vault === vault && record.syncs) claims.claimed(vault, was);
    },
    claimUnshared: claims.unshared,
    claimWas: claims.was,
    namedOnGitHub: (vault) => {
      const thisMacId = here.thisMacId();
      return thisMacId !== null && claims.namedOnGitHub(vault, thisMacId);
    },
    sleptSincePull: (vault) => record.vault === vault && record.slept,
  };
}
