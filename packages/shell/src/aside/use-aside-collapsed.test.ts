// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  ASIDE_COLLAPSES_BELOW,
  ASIDE_COLLAPSES_BELOW_ALONE,
  ASIDE_WIDTH_TYPE,
  asideCollapsesBelow,
  collapseFor,
} from '@dfai/ui';
import { useAsideCollapsed } from './use-aside-collapsed.ts';

/**
 * A `matchMedia` that answers `(max-width: Npx)` for a window of `width`, and
 * can be resized: jsdom has none of its own.
 */
function windowOf(width: number) {
  const listeners = new Set<() => void>();
  const current = { width };
  const maxWidthOf = (query: string) => Number(/max-width: (\d+)px/.exec(query)?.[1]);
  window.matchMedia = vi.fn((query: string) => ({
    get matches() {
      return current.width <= maxWidthOf(query);
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
  return {
    resize: (to: number) => {
      current.width = to;
      listeners.forEach((listener) => listener());
    },
    listeners,
  };
}

describe('useAsideCollapsed', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is collapseFor applied to the window’s width, with the sidebar open', () => {
    const screen = windowOf(1200);
    const { result } = renderHook(() => useAsideCollapsed({ sidebarOpen: true }));
    expect(result.current).toBe(collapseFor({ width: 1200, sidebarOpen: true }).aside);
    expect(result.current).toBe(false);

    act(() => screen.resize(ASIDE_COLLAPSES_BELOW - 1));
    expect(result.current).toBe(true);
    expect(collapseFor({ width: ASIDE_COLLAPSES_BELOW - 1, sidebarOpen: true }).aside).toBe(true);

    act(() => screen.resize(ASIDE_COLLAPSES_BELOW));
    expect(result.current).toBe(false);
  });

  it('folds later once the left sidebar is hidden by hand', () => {
    const width = ASIDE_COLLAPSES_BELOW - 1;
    windowOf(width);
    const { result, rerender } = renderHook(
      ({ sidebarOpen }: { sidebarOpen: boolean }) => useAsideCollapsed({ sidebarOpen }),
      { initialProps: { sidebarOpen: true } },
    );
    expect(result.current).toBe(true);
    rerender({ sidebarOpen: false });
    expect(result.current).toBe(collapseFor({ width, sidebarOpen: false }).aside);
    expect(result.current).toBe(false);
    expect(width).toBeGreaterThanOrEqual(ASIDE_COLLAPSES_BELOW_ALONE);
  });

  it('folds the wider type editor sooner, by the same rule (shell.css’s .aside--type queries)', () => {
    const typeBelow = asideCollapsesBelow({ sidebarOpen: true, asideWidth: ASIDE_WIDTH_TYPE });
    // Wide enough for the 300px aside, not for the 340px one.
    const width = typeBelow - 1;
    expect(width).toBeGreaterThanOrEqual(ASIDE_COLLAPSES_BELOW);
    windowOf(width);
    const { result, rerender } = renderHook(
      ({ asideWidth }: { asideWidth: number }) =>
        useAsideCollapsed({ sidebarOpen: true, asideWidth }),
      { initialProps: { asideWidth: ASIDE_WIDTH_TYPE } },
    );
    expect(result.current).toBe(true);
    rerender({ asideWidth: 300 });
    expect(result.current).toBe(false);
  });

  it('stops listening as it unmounts', () => {
    const screen = windowOf(1200);
    const { unmount } = renderHook(() => useAsideCollapsed({ sidebarOpen: true }));
    expect(screen.listeners.size).toBe(1);
    unmount();
    expect(screen.listeners.size).toBe(0);
  });
});

describe('useAsideCollapsed without matchMedia', () => {
  it('never folds where the window cannot answer a media query (jsdom)', () => {
    // @ts-expect-error -- jsdom's window has no matchMedia; this is that window.
    delete window.matchMedia;
    const { result } = renderHook(() => useAsideCollapsed({ sidebarOpen: true }));
    expect(result.current).toBe(false);
  });
});
