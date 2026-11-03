// @vitest-environment jsdom
import type { PendingSavesPort, PendingSaveState } from '@dfai/application';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePendingSave } from './use-pending-save.ts';

const VAULT = 'github:mara-quill/larkspur-vault#main';

function pendingSaves() {
  let state: PendingSaveState | null = null;
  const listeners = new Set<() => void>();
  const port: PendingSavesPort = {
    stateOf: (vault, path) => (vault === VAULT && path === 'Plan.md' ? state : null),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    keepAsCopy: async () => {},
    discard: async () => {},
  };
  const set = (next: PendingSaveState | null) =>
    act(() => {
      state = next;
      listeners.forEach((listener) => listener());
    });
  return { port, set, listeners };
}

describe('usePendingSave', () => {
  it('follows the note’s queued save: waiting, refused with its reason, then gone', () => {
    const { port, set } = pendingSaves();
    const { result } = renderHook(() => usePendingSave(port, VAULT, 'Plan.md'));
    expect(result.current).toBeNull();
    set({ kind: 'waiting' });
    expect(result.current).toEqual({ kind: 'waiting' });
    set({ kind: 'refused', reason: 'the note changed on disk since it was opened' });
    expect(result.current).toEqual({
      kind: 'refused',
      reason: 'the note changed on disk since it was opened',
    });
    set(null);
    expect(result.current).toBeNull();
  });

  it('is null for another note, with no vault, or with no queue at all', () => {
    const { port, set } = pendingSaves();
    const other = renderHook(() => usePendingSave(port, VAULT, 'Other.md'));
    const noVault = renderHook(() => usePendingSave(port, null, 'Plan.md'));
    const none = renderHook(() => usePendingSave(undefined, VAULT, 'Plan.md'));
    set({ kind: 'waiting' });
    expect([other.result.current, noVault.result.current, none.result.current]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('stops listening once the pane is gone', () => {
    const { port, listeners } = pendingSaves();
    const { unmount } = renderHook(() => usePendingSave(port, VAULT, 'Plan.md'));
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });
});
