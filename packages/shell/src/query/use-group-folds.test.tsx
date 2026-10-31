// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { GroupFoldStore } from '@dfai/ui';
import { useGroupFolds } from './use-group-folds.ts';

/** A store held in a map, as localStorage would hold it. */
function memoryStore(seed: Record<string, readonly string[]> = {}) {
  const held = new Map(Object.entries(seed));
  const store: GroupFoldStore = {
    read: (view) => held.get(view) ?? [],
    write: (view, collapsed) => {
      held.set(view, collapsed);
    },
  };
  return { store, held };
}

describe('useGroupFolds', () => {
  it('opens a view with the groups it was left with folded', () => {
    const { store } = memoryStore({ board: ['doing'] });
    const { result } = renderHook(() => useGroupFolds({ store, view: 'board' }));
    expect([...result.current.collapsed]).toEqual(['doing']);
  });

  it('folds and unfolds a group, writing it back at once', () => {
    const { store, held } = memoryStore();
    const { result } = renderHook(() => useGroupFolds({ store, view: 'board' }));
    act(() => result.current.onToggle('doing'));
    expect(result.current.collapsed.has('doing')).toBe(true);
    expect(held.get('board')).toEqual(['doing']);
    act(() => result.current.onToggle('doing'));
    expect(result.current.collapsed.has('doing')).toBe(false);
    expect(held.get('board')).toEqual([]);
  });

  it('reads another view’s folds when the pane opens it', () => {
    const { store } = memoryStore({ board: ['doing'], table: ['home'] });
    const { result, rerender } = renderHook(({ view }) => useGroupFolds({ store, view }), {
      initialProps: { view: 'board' },
    });
    rerender({ view: 'table' });
    expect([...result.current.collapsed]).toEqual(['home']);
    act(() => result.current.onToggle('work'));
    rerender({ view: 'board' });
    expect([...result.current.collapsed]).toEqual(['doing']);
  });
});
