// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePhase } from './use-phase.ts';

describe('usePhase (#630 review)', () => {
  it('answers how sync stands the moment it is set, before the window is drawn again', () => {
    const { result } = renderHook(() => usePhase());
    const { setPhase, phaseNow } = result.current;
    const failed = { kind: 'failed', reason: 'offline', at: 1 } as const;

    // Asked in the same turn as a look that just failed, as a claim at its turn is.
    let seen;
    act(() => {
      setPhase(failed);
      seen = phaseNow();
    });

    expect(seen).toBe(failed);
    expect(result.current.phase).toBe(failed);
  });
});
