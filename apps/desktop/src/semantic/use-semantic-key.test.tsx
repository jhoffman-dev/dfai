// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { BuildProgress } from '@dfai/application';
import { useSemanticKey, type MeaningSource } from './use-semantic-key.ts';

function engine(start: BuildProgress) {
  let current = start;
  const listeners = new Set<(progress: BuildProgress) => void>();
  const source: MeaningSource = {
    search: async () => ({ hits: [], progress: current }),
    progress: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    listeners,
    move(next: BuildProgress) {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

describe('useSemanticKey', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('moves at once for a build that began, and not for each small write after it', () => {
    const build = engine({ done: 0, total: 0, failure: null });
    const { result } = renderHook(() => useSemanticKey(build.source));
    expect(result.current).toBe('0/0/');
    act(() => build.move({ done: 0, total: 1_000, failure: null }));
    expect(result.current).toBe('0/1000/');
    // 16 notes of 1,000 is under 5%: the key waits for its second.
    act(() => build.move({ done: 16, total: 1_000, failure: null }));
    act(() => build.move({ done: 32, total: 1_000, failure: null }));
    expect(result.current).toBe('0/1000/');
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current).toBe('32/1000/');
  });

  it('moves at once for 5% of the notes, for a failure, and for a build that finished', () => {
    const build = engine({ done: 0, total: 1_000, failure: null });
    const { result } = renderHook(() => useSemanticKey(build.source));
    act(() => build.move({ done: 50, total: 1_000, failure: null }));
    expect(result.current).toBe('50/1000/');
    act(() => build.move({ done: 60, total: 1_000, failure: 'no network' }));
    expect(result.current).toBe('60/1000/no network');
    act(() => build.move({ done: 0, total: 0, failure: null }));
    expect(result.current).toBe('0/0/');
  });

  it('listens to nothing where no key is wanted', () => {
    const build = engine({ done: 0, total: 0, failure: null });
    renderHook(() => useSemanticKey(null));
    expect(build.listeners.size).toBe(0);
    const { unmount } = renderHook(() => useSemanticKey(build.source));
    expect(build.listeners.size).toBe(1);
    unmount();
    expect(build.listeners.size).toBe(0);
  });
});
