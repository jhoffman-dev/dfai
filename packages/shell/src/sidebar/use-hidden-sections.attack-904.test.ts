// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { parseHiddenSections, shownSections, type SidebarSectionId } from '@dfai/domain';
import { useHiddenSections, type HiddenSectionStore } from './use-hidden-sections.ts';

// Attack on #902 (PR #904). parseHiddenSections refuses a list that hides every
// section, "since it would leave the sidebar without a section to show". The
// hook does not hold the same line: from a kept list that hides the other four
// (a hand edit, an older build, a second window), hiding Pages leaves the
// sidebar with nothing in it, and writes that list back.

const OTHER_FOUR: readonly SidebarSectionId[] = ['favorites', 'types', 'views', 'dashboards'];

describe('useHiddenSections (attack-904)', () => {
  it('never leaves the sidebar with no section to show', () => {
    const writes: SidebarSectionId[][] = [];
    const store: HiddenSectionStore = {
      read: () => parseHiddenSections([...OTHER_FOUR]),
      write: (ids) => writes.push([...ids]),
    };
    const { result } = renderHook(() => useHiddenSections(store));
    // Precondition: the kept list is taken as it is, Pages alone shown.
    expect(shownSections({ order: null, hidden: result.current.hidden })).toEqual(['userSpace']);

    act(() => result.current.setShown('userSpace', false));

    expect(shownSections({ order: null, hidden: result.current.hidden })).not.toEqual([]);
  });

  it('never remembers a list the next start will refuse as corrupt', () => {
    const writes: SidebarSectionId[][] = [];
    const store: HiddenSectionStore = {
      read: () => parseHiddenSections([...OTHER_FOUR]),
      write: (ids) => writes.push([...ids]),
    };
    const { result } = renderHook(() => useHiddenSections(store));

    act(() => result.current.setShown('userSpace', false));

    const written = writes.at(-1) ?? result.current.hidden;
    // What this session shows must be what the next start reads back.
    expect(parseHiddenSections([...written])).toEqual([...result.current.hidden]);
  });
});
