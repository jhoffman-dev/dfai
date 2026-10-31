// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { VaultPath, ViewEdits } from '@dfai/domain';
import { useViewDrafts } from './use-view-drafts.ts';

const BOARD = '.atlas/views/Board.md';
const edits: ViewEdits = { groupBy: 'status' };

describe('useViewDrafts', () => {
  it('holds a view’s unsaved edits by its path', () => {
    const { result } = renderHook(() => useViewDrafts('/vaults/work'));
    act(() => result.current.setEdits(BOARD, edits));
    expect(result.current.editsFor(BOARD)).toBe(edits);
    expect(result.current.editsFor('.atlas/views/Other.md')).toEqual({});
  });

  it('shows none of one vault’s drafts in another, even at the same path', () => {
    const { result, rerender } = renderHook(({ vault }) => useViewDrafts(vault), {
      initialProps: { vault: '/vaults/work' as string | null },
    });
    act(() => result.current.setEdits(BOARD, edits));
    rerender({ vault: '/vaults/home' });
    expect(result.current.editsFor(BOARD)).toEqual({});
  });

  it('follows a view that is renamed', () => {
    const { result } = renderHook(() => useViewDrafts('/vaults/work'));
    act(() => result.current.setEdits(BOARD, edits));
    act(() =>
      result.current.follow({
        from: BOARD as VaultPath,
        to: '.atlas/views/Kanban.md' as VaultPath,
      }),
    );
    expect(result.current.editsFor('.atlas/views/Kanban.md')).toBe(edits);
    expect(result.current.editsFor(BOARD)).toEqual({});
  });

  it('forgets a deleted view’s edits, so a new view at its path starts clean', () => {
    const { result } = renderHook(() => useViewDrafts('/vaults/work'));
    act(() => result.current.setEdits(BOARD, edits));
    act(() => result.current.setEdits('.atlas/views/Other.md', edits));
    act(() => result.current.forget([BOARD as VaultPath]));
    expect(result.current.editsFor(BOARD)).toEqual({});
    expect(result.current.editsFor('.atlas/views/Other.md')).toBe(edits);
  });

  it('forgets the edits of every view in a deleted folder', () => {
    const { result } = renderHook(() => useViewDrafts('/vaults/work'));
    act(() => result.current.setEdits(BOARD, edits));
    act(() => result.current.forget(['.atlas/views' as VaultPath]));
    expect(result.current.editsFor(BOARD)).toEqual({});
  });
});
