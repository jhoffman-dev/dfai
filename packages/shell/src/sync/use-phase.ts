import { useCallback, useRef, useState } from 'react';
import type { SyncPhase } from '@dfai/domain';

/**
 * How the vault's sync stands, drawn, and as it stands now: a claim asks the
 * gates at its turn, which may come before the window is drawn again after
 * a look that just failed (#630 review).
 */
export function usePhase() {
  const [phase, setDrawn] = useState<SyncPhase>({ kind: 'unknown' });
  const now = useRef(phase);
  const setPhase = useCallback((next: SyncPhase) => {
    now.current = next;
    setDrawn(next);
  }, []);
  const phaseNow = useCallback(() => now.current, []);
  return { phase, setPhase, phaseNow };
}
