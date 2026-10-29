import { useCallback, useEffect, useRef } from 'react';
import type { SyncPhase, SyncReport } from '@dfai/domain';
import {
  checkRemote,
  createUnsettledSaid,
  inspectSync,
  syncNow,
  type ActivityRecorder,
  type Clock,
  type GitFoldersPort,
  type GitPort,
  type MarkdownPort,
  type SyncFilesPort,
  type SyncSetup,
  type UnsettledSaid,
  type VaultFsPort,
} from '@dfai/application';
import { errorMessage } from '../query/error-message.ts';
import type { PullRecorder } from './use-pulled-files.ts';

/** This Mac: its name, and the id it keeps for itself. */
export interface ThisMac {
  readonly name: string;
  readonly id: string;
}

/** What the vault's one git run at a time is doing. */
export type RunKind = 'sync' | 'check' | 'set-up';

/**
 * How long a vault being left takes no new git run, once its switch has
 * waited for the one under way: the switch itself follows at once, and a
 * switch that does not happen (the same vault chosen again, a failed store)
 * must not stop sync for good.
 */
export const LEAVING_MS = 5_000;

/**
 * The one git run of the vault at a time, in the order asked for: each
 * starts once the one before it has ended. A sync asked for while another
 * sync is the last in line is that one; a look is skipped while anything
 * runs. A vault switch waits for whichever is last in line, and nothing new
 * starts on the vault being left (review A29-01).
 */
export function useExclusive(clock: Pick<Clock, 'now'>, vaultKey: string | null) {
  const running = useRef<{ kind: RunKind; done: Promise<unknown> } | null>(null);
  const leavingUntil = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    leavingUntil.current = Number.NEGATIVE_INFINITY;
  }, [vaultKey]);
  const current = useCallback(() => running.current, []);
  const open = useCallback(() => clock.now() >= leavingUntil.current, [clock]);
  const start = useCallback(
    <Result>(kind: RunKind, work: () => Promise<Result>): Promise<Result> => {
      // The one before has said why, if it failed; this only waits for it to end.
      const before = running.current?.done.catch(() => undefined) ?? Promise.resolve();
      const started = before.then(work).finally(() => {
        if (running.current?.done === started) running.current = null;
      });
      running.current = { kind, done: started };
      return started;
    },
    [],
  );
  const settle = useCallback(async () => {
    leavingUntil.current = clock.now() + LEAVING_MS;
    // A failed run has already said why; the switch only waits for it to end.
    await running.current?.done.catch(() => undefined);
  }, [clock]);
  return { current, open, start, settle };
}

export type Exclusive = ReturnType<typeof useExclusive>;

export interface RunContext {
  readonly git: GitPort | null;
  readonly files: SyncFilesPort | null;
  readonly thisMac: ThisMac | null;
  readonly vaultKey: string | null;
  readonly fs: VaultFsPort;
  /** To merge a settings file both Macs changed by its keys (#233). */
  readonly markdown: MarkdownPort;
  readonly clock: Pick<Clock, 'now' | 'localNow'>;
  readonly activity: { inVault(vault: string): ActivityRecorder };
  readonly flushAll: () => Promise<void>;
  readonly onPulled: () => void;
  readonly setPhase: (phase: SyncPhase) => void;
  readonly setBehind: (behind: number) => void;
  /**
   * Says a sync of the vault has pulled from GitHub in this session, and
   * whether it brought other Macs' files in.
   */
  readonly markSynced: (vault: string, broughtIn?: boolean) => void;
  readonly exclusive: Exclusive;
  /** Told as each pull and look starts and ends, for the gates of ADR-0035 part 4. */
  readonly pulls: PullRecorder;
}

/**
 * Syncs, one at a time, and looks at GitHub for other Macs' changes between
 * them: a look that finds some starts a sync to bring them in.
 */
/** The record of what was said for `vault`, made afresh when another vault opened since. */
function saidFor(
  held: { current: { vault: string; said: UnsettledSaid } | null },
  vault: string,
): UnsettledSaid {
  if (held.current?.vault !== vault) held.current = { vault, said: createUnsettledSaid() };
  return held.current.said;
}

export function useSyncRuns(context: RunContext) {
  const { git, files, thisMac, vaultKey, fs, markdown, clock, activity, flushAll } = context;
  const { setPhase, setBehind, markSynced, exclusive, pulls } = context;
  const lastSyncAt = useRef<number | null>(null);
  const lastCheckAt = useRef<number | null>(null);
  // What this window has said of copies sync kept (#235), for the vault open: said once each.
  const copiesSaid = useRef<{ vault: string; said: UnsettledSaid } | null>(null);
  const openVault = useRef(vaultKey);
  openVault.current = vaultKey;
  const pulled = useRef(context.onPulled);
  pulled.current = context.onPulled;

  const run = useCallback((): Promise<SyncReport | null> => {
    if (git === null || files === null || vaultKey === null || thisMac === null) {
      return Promise.resolve(null);
    }
    if (!exclusive.open()) return Promise.resolve(null);
    const under = exclusive.current();
    if (under?.kind === 'sync') {
      return under.done.then(
        (report) => report as SyncReport | null,
        () => null,
      );
    }
    const now = clock.now();
    lastSyncAt.current = now;
    lastCheckAt.current = now;
    setPhase({ kind: 'syncing' });
    const ports = {
      git,
      fs,
      markdown,
      files,
      unsaved: { flushAll },
      activity: activity.inVault(vaultKey),
      copiesSaid: saidFor(copiesSaid, vaultKey),
    };
    const current = () => openVault.current === vaultKey;
    return exclusive.start('sync', async () => {
      pulls.started(vaultKey);
      const startedAsleepMs = await pulls.readAsleep();
      return syncNow({ ports, mac: thisMac.name, clock })
        .then(async (report) => {
          // Before anything hears of what it brought: the settings it brought decide who acts on it.
          await pulls.ended(vaultKey, { kind: 'synced' }, startedAsleepMs);
          const broughtIn = report.pulled || report.conflicts.length > 0;
          // Pulled whether or not the vault is still open: the session has synced it.
          markSynced(vaultKey, broughtIn);
          if (!current()) return report;
          setBehind(0);
          setPhase({ kind: 'synced', report });
          if (broughtIn) pulled.current();
          return report;
        })
        .catch(async (cause: unknown) => {
          // It may have brought files in before it failed: what they hold is not known.
          await pulls.ended(vaultKey, { kind: 'sync-failed' }, startedAsleepMs);
          if (current()) setPhase({ kind: 'failed', reason: errorMessage(cause), at: clock.now() });
          return null;
        });
    });
  }, [
    git,
    files,
    vaultKey,
    thisMac,
    clock,
    fs,
    markdown,
    flushAll,
    activity,
    setPhase,
    setBehind,
    markSynced,
    exclusive,
    pulls,
  ]);

  /**
   * Looks at GitHub: how many of the other Macs' commits are not here, and
   * how many of this Mac's have not reached GitHub (none when it could not look).
   */
  const check = useCallback(async (): Promise<{ behind: number; ahead: number }> => {
    const nothing = { behind: 0, ahead: 0 };
    if (git === null || vaultKey === null) return nothing;
    if (!exclusive.open() || exclusive.current() !== null) return nothing;
    lastCheckAt.current = clock.now();
    const current = () => openVault.current === vaultKey;
    const found = await exclusive
      .start('check', () => lookAtGitHub({ git, vault: vaultKey, pulls }))
      .catch((cause: unknown) => {
        if (current()) setPhase({ kind: 'failed', reason: errorMessage(cause), at: clock.now() });
        return nothing;
      });
    if (!current()) return nothing;
    setBehind(found.behind);
    return found;
  }, [git, vaultKey, clock, setPhase, setBehind, exclusive, pulls]);

  return { run, check, lastSyncAt, lastCheckAt };
}

/** Looks at GitHub, and tells the gates what it found, or that it failed (see `pullEndEffect`). */
async function lookAtGitHub({
  git,
  vault,
  pulls,
}: {
  git: GitPort;
  vault: string;
  pulls: PullRecorder;
}): Promise<{ behind: number; ahead: number }> {
  const startedAsleepMs = await pulls.readAsleep();
  let found: { behind: number; ahead: number };
  try {
    found = await checkRemote({ git });
  } catch (cause) {
    await pulls.ended(vault, { kind: 'look-failed' }, startedAsleepMs);
    throw cause;
  }
  await pulls.ended(vault, { kind: 'looked', behind: found.behind }, startedAsleepMs);
  return found;
}

/** Reads how the vault stands with sync as it opens, and pulls if it syncs. */
export function useInspection({
  git,
  folders,
  fs,
  markdown,
  vaultKey,
  thisMac,
  clock,
  setSetup,
  setPhase,
  setBehind,
  markSynced,
  pulls,
  run,
  paused,
}: {
  git: GitPort | null;
  folders: GitFoldersPort;
  fs: VaultFsPort;
  markdown: MarkdownPort;
  vaultKey: string | null;
  thisMac: ThisMac | null;
  clock: Pick<Clock, 'now'>;
  setSetup: (setup: SyncSetup | null) => void;
  setPhase: (phase: SyncPhase) => void;
  setBehind: (behind: number) => void;
  /** Says the vault has nothing to wait for from GitHub, when it does not sync. */
  markSynced: (vault: string) => void;
  pulls: Pick<PullRecorder, 'inspected' | 'inspectionFailed'>;
  run: () => Promise<SyncReport | null>;
  /** Whether sync is paused on this Mac as the vault opens: then it does not pull on open. */
  paused: () => boolean;
}) {
  const runOnOpen = useRef(run);
  runOnOpen.current = run;
  const pausedNow = useRef(paused);
  pausedNow.current = paused;
  useEffect(() => {
    setSetup(null);
    setPhase({ kind: 'unknown' });
    setBehind(0);
    if (git === null || vaultKey === null || thisMac === null) return;
    let live = true;
    inspectSync({ git, folders, fs, markdown, vaultRoot: vaultKey })
      .then((setup) => {
        if (!live) return;
        setSetup(setup);
        setPhase(phaseOf(setup));
        pulls.inspected(vaultKey, setup.kind === 'set-up');
        if (setup.kind !== 'set-up') {
          markSynced(vaultKey);
          return;
        }
        setBehind(setup.behind);
        if (!pausedNow.current()) void runOnOpen.current();
      })
      .catch((cause: unknown) => {
        if (!live) return;
        // Git not on this Mac: the vault cannot sync here, and its files wait for no pull.
        pulls.inspectionFailed(vaultKey, cause);
        setPhase({ kind: 'failed', reason: errorMessage(cause), at: clock.now() });
      });
    return () => {
      live = false;
    };
  }, [
    git,
    folders,
    fs,
    markdown,
    vaultKey,
    thisMac,
    clock,
    setSetup,
    setPhase,
    setBehind,
    markSynced,
    pulls,
  ]);
}

/** What the vault's sync state reads as, once how it stands is known. */
export function phaseOf(setup: SyncSetup): SyncPhase {
  if (setup.kind === 'refused') return { kind: 'refused', reason: setup.reason };
  return setup.kind === 'not-set-up' ? { kind: 'not-set-up' } : { kind: 'ready' };
}
