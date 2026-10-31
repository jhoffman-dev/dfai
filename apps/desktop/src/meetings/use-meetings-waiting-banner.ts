import { useCallback, useMemo, useRef, useState } from 'react';
import {
  claimProblem,
  claimRefusalLine,
  claimUnsharedLine,
  meetingsWaitingLine,
  processHereRefusal,
  type ClaimRefusal,
  type MeetingsWaiting,
} from '@dfai/domain';
import type { MeetingsWaitingProps } from '@dfai/ui';
import { useProcessHereSync, type SyncStore } from '../sync/sync-store.ts';
import { useMeetingsWaiting, type MeetingsWaitingStore } from './meetings-waiting-store.ts';

/** What the banner was judged on: a press's problem holds only while these are as they were. */
interface Judged {
  readonly waiting: MeetingsWaiting | null;
  readonly refused: ClaimRefusal | null;
}

/** A press of "Process here", kept with the vault it was made in and what it was answered against. */
interface Press {
  readonly vault: string;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly against: Judged | null;
}

const sameJudged = (one: Judged | null, other: Judged) =>
  one !== null && one.waiting === other.waiting && one.refused === other.refused;

/**
 * The Inbox's banner on a Mac that is not named (ADR-0035 parts 1 and 2):
 * the line the meeting import last said, and "Process here", refused while
 * the facts that judged the line say a claim could not be shared. Once the
 * claim names this Mac, the import stops counting and the banner goes. On
 * the named Mac it says instead that its step cannot reach Claude, and what
 * fixes it (#182).
 */
export function useMeetingsWaitingBanner({
  waiting: store,
  sync,
  vaultKey,
}: {
  waiting: MeetingsWaitingStore;
  sync: SyncStore;
  vaultKey: string | null;
}): MeetingsWaitingProps | null {
  const waiting = useMeetingsWaiting(store, vaultKey);
  const claim = useProcessHereSync(sync, vaultKey);
  const [press, setPress] = useState<Press | null>(null);
  const pressed = press?.vault === vaultKey ? press : null;
  const refused =
    waiting === null || claim === null
      ? null
      : processHereRefusal({ waiting, failing: claim.failing });
  // What the banner is judged on as drawn now, for the answer to a press to be kept against.
  const judged = useRef<Judged>({ waiting, refused });
  judged.current = { waiting, refused };
  const processHere = claim?.processHere;
  const onPress = useCallback(() => {
    if (vaultKey === null || processHere === undefined) return;
    const vault = vaultKey;
    const answered = (problem: string | null) =>
      setPress({ vault, busy: false, problem, against: judged.current });
    setPress({ vault, busy: true, problem: null, against: null });
    void processHere().then(
      (outcome) => answered(claimProblem(outcome)),
      (cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        answered(claimProblem({ kind: 'write-failed', reason }));
      },
    );
  }, [vaultKey, processHere]);
  return useMemo(() => {
    // Set here and not yet shared: said until a sync pushes it, with nothing to press.
    if (claim?.pending) return { line: claimUnsharedLine(claim.pending.was), processHere: null };
    const line = waiting === null ? null : meetingsWaitingLine(waiting);
    if (waiting === null || line === null) return null;
    // The named Mac's own step is failing: there is nothing to claim, only what to fix.
    if (waiting.kind === 'failing') return { line, detail: waiting.problem, processHere: null };
    if (claim === null) return { line, processHere: null };
    // A press's problem is dropped once what it was answered against has changed.
    const current = sameJudged(pressed?.against ?? null, { waiting, refused });
    return {
      line,
      processHere: {
        refused: refused === null ? null : claimRefusalLine(refused),
        busy: pressed?.busy ?? false,
        problem: current ? (pressed?.problem ?? null) : null,
        onPress,
      },
    };
  }, [waiting, claim, refused, pressed, onPress]);
}
