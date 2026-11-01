// @vitest-environment jsdom
/**
 * Adversarial pass on issue #6: one view open in two panes, each folding a
 * different group. Seen failing first.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { GroupFoldStore } from '@dfai/ui';
import { useGroupFolds } from './use-group-folds.ts';

function memoryStore() {
  const held = new Map<string, readonly string[]>();
  const store: GroupFoldStore = {
    read: (view) => held.get(view) ?? [],
    write: (view, collapsed) => {
      held.set(view, collapsed);
    },
  };
  return { store, held };
}

describe('one view folded in two panes', () => {
  it('keeps both panes’ folds: the second fold does not undo the first', () => {
    const { store, held } = memoryStore();
    const left = renderHook(() => useGroupFolds({ store, view: 'board' }));
    const right = renderHook(() => useGroupFolds({ store, view: 'board' }));
    act(() => left.result.current.onToggle('doing'));
    act(() => right.result.current.onToggle('done'));
    expect([...(held.get('board') ?? [])].sort()).toEqual(['doing', 'done']);
  });
});
