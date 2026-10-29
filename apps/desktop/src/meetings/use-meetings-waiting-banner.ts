import { useCallback, useMemo, useState } from 'react';
import {
  claimProblem,
  claimRefusalLine,
  meetingsWaitingLine,
  processHereRefusal,
} from '@dfai/domain';
import type { MeetingsWaitingProps } from '@dfai/ui';
import { useProcessHereSync, type SyncStore } from '../sync/sync-store.ts';
import { useMeetingsWaiting, type MeetingsWaitingStore } from './meetings-waiting-store.ts';

/** A press of "Process here", kept with the vault it was made in. */
interface Press {
  readonly vault: string;
  readonly busy: boolean;
  readonly problem: string | null;
}

/**
 * The Inbox's banner on a Mac that is not named (ADR-0035 parts 1 and 2):
 * the line the meeting import last said, and "Process here", refused while
 * the facts that judged the line say a claim could not be shared. Once the
 * claim names this Mac, the import stops counting and the banner goes.
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
  const processHere = claim?.processHere;
  const onPress = useCallback(() => {
    if (vaultKey === null || processHere === undefined) return;
    const vault = vaultKey;
    setPress({ vault, busy: true, problem: null });
    void processHere().then(
      (outcome) => setPress({ vault, busy: false, problem: claimProblem(outcome) }),
      (cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        setPress({ vault, busy: false, problem: claimProblem({ kind: 'write-failed', reason }) });
      },
    );
  }, [vaultKey, processHere]);
  return useMemo(() => {
    const line = waiting === null ? null : meetingsWaitingLine(waiting);
    if (waiting === null || line === null) return null;
    if (claim === null) return { line, processHere: null };
    const refused = processHereRefusal({ waiting, failing: claim.failing });
    return {
      line,
      processHere: {
        refused: refused === null ? null : claimRefusalLine(refused),
        busy: pressed?.busy ?? false,
        problem: pressed?.problem ?? null,
        onPress,
      },
    };
  }, [waiting, claim, pressed, onPress]);
}
