// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { SidebarSectionId } from '@dfai/domain';
import { useHiddenSections, type HiddenSectionStore } from './use-hidden-sections.ts';

/** A store that starts with `kept` and records every write. */
function memoryStore(kept: readonly SidebarSectionId[]) {
  const writes: SidebarSectionId[][] = [];
  const store: HiddenSectionStore = { read: () => kept, write: (ids) => writes.push([...ids]) };
  return { store, writes };
}

describe('useHiddenSections', () => {
  it('starts from what the store reads', () => {
    const { store } = memoryStore(['userSpace']);
    const { result } = renderHook(() => useHiddenSections(store));
    expect(result.current.hidden).toEqual(['userSpace']);
    expect(result.current.isShown('userSpace')).toBe(false);
    expect(result.current.isShown('views')).toBe(true);
  });

  it('shows a section, then hides it again, remembering each choice', () => {
    const { store, writes } = memoryStore(['userSpace']);
    const { result } = renderHook(() => useHiddenSections(store));

    act(() => result.current.setShown('userSpace', true));
    expect(result.current.isShown('userSpace')).toBe(true);

    act(() => result.current.setShown('userSpace', false));
    expect(result.current.isShown('userSpace')).toBe(false);
    expect(writes).toEqual([[], ['userSpace']]);
  });

  it('writes nothing, and hands back the same list, when asked for what already holds', () => {
    const { store, writes } = memoryStore([]);
    const { result } = renderHook(() => useHiddenSections(store));
    const before = result.current.hidden;

    act(() => result.current.setShown('userSpace', true));
    expect(writes).toEqual([]);
    expect(result.current.hidden).toBe(before);
  });
});
