// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { COMPACT_BELOW, MAX_PANES } from '@dfai/domain';
import { useShellLayout } from './use-shell-layout.ts';

const originalWidth = window.innerWidth;

function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

function resizeTo(width: number): void {
  act(() => {
    setWidth(width);
    window.dispatchEvent(new Event('resize'));
  });
}

afterEach(() => setWidth(originalWidth));

describe('useShellLayout', () => {
  it('reads the window as it is on the first draw', () => {
    setWidth(820);
    const { result } = renderHook(() => useShellLayout());
    expect(result.current).toEqual({ sidebar: 'drawer', panes: 1 });
  });

  it('follows the window across the breakpoint, in both directions', () => {
    setWidth(1180);
    const { result } = renderHook(() => useShellLayout());
    expect(result.current).toEqual({ sidebar: 'beside', panes: MAX_PANES });
    resizeTo(COMPACT_BELOW - 1);
    expect(result.current).toEqual({ sidebar: 'drawer', panes: 1 });
    resizeTo(COMPACT_BELOW);
    expect(result.current).toEqual({ sidebar: 'beside', panes: MAX_PANES });
  });

  it('hands back the same object while the width stays on one side, so nothing draws again', () => {
    setWidth(1440);
    const { result } = renderHook(() => useShellLayout());
    const before = result.current;
    resizeTo(1000);
    expect(result.current).toBe(before);
  });

  it('stops listening once it is gone', () => {
    setWidth(1440);
    const { result, unmount } = renderHook(() => useShellLayout());
    unmount();
    resizeTo(390);
    expect(result.current.sidebar).toBe('beside');
  });
});
