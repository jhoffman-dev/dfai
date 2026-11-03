import { useCallback, useSyncExternalStore } from 'react';
import type { PendingSavesPort, PendingSaveState } from '@dfai/application';

const NONE = '';
const WAITING = 'waiting';
const REFUSED = 'refused:';

/**
 * The note's save waiting on the device (#667): to be sent, or refused once
 * sent. Null where the platform has no queue, as the desktop has none, and
 * then nothing is subscribed to.
 */
export function usePendingSave(
  pending: PendingSavesPort | undefined,
  vault: string | null,
  path: string | null,
): PendingSaveState | null {
  const subscribe = useCallback(
    (listener: () => void) => pending?.subscribe(listener) ?? (() => {}),
    [pending],
  );
  // A string, so the same state reads as the same snapshot and draws nothing again.
  const snapshot = () => {
    if (pending === undefined || vault === null || path === null) return NONE;
    const state = pending.stateOf(vault, path);
    if (state === null) return NONE;
    return state.kind === 'waiting' ? WAITING : `${REFUSED}${state.reason}`;
  };
  const held = useSyncExternalStore(subscribe, snapshot);
  if (held === NONE) return null;
  if (held === WAITING) return { kind: 'waiting' };
  return { kind: 'refused', reason: held.slice(REFUSED.length) };
}
