// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createVaultPath, type LinkFragment } from '@dfai/domain';
import { createRevealStore, requestReveal, useTabReveal } from './reveals.ts';

const NOTE = createVaultPath('Plan.md');
const OTHER = createVaultPath('Other.md');
const fragment: LinkFragment = { kind: 'heading', heading: 'Goals' };

describe('the reveal store', () => {
  it('hands a tab the reveal asked of it for the note it shows, and spends it once shown', () => {
    const store = createRevealStore();
    const shown = renderHook(() => useTabReveal(store, { tab: 't1', path: NOTE }));
    expect(shown.result.current).toBeNull();

    act(() => requestReveal(store, { tab: 't1', path: NOTE, fragment }));
    const reveal = shown.result.current;
    expect(reveal?.fragment).toEqual(fragment);

    act(() => reveal?.done?.());
    expect(shown.result.current).toBeNull();
  });

  it('keeps a request for the note it was made for, and for its tab alone', () => {
    const store = createRevealStore();
    requestReveal(store, { tab: 't1', path: NOTE, fragment });
    const movedOn = renderHook(() => useTabReveal(store, { tab: 't1', path: OTHER }));
    const otherTab = renderHook(() => useTabReveal(store, { tab: 't2', path: NOTE }));
    expect(movedOn.result.current).toBeNull();
    expect(otherTab.result.current).toBeNull();
  });

  it('scrolls again for the same link followed twice, and a stale done spends nothing', () => {
    const store = createRevealStore();
    const shown = renderHook(() => useTabReveal(store, { tab: 't1', path: NOTE }));
    act(() => requestReveal(store, { tab: 't1', path: NOTE, fragment }));
    const first = shown.result.current;
    act(() => requestReveal(store, { tab: 't1', path: NOTE, fragment }));
    const second = shown.result.current;
    expect(second?.key).not.toBe(first?.key);

    act(() => first?.done?.());
    expect(shown.result.current).toBe(second);
  });

  it('draws only the tab a request is for', () => {
    const store = createRevealStore();
    let otherDrawn = 0;
    renderHook(() => {
      otherDrawn += 1;
      return useTabReveal(store, { tab: 't2', path: OTHER });
    });
    const before = otherDrawn;
    act(() => requestReveal(store, { tab: 't1', path: NOTE, fragment }));
    expect(otherDrawn - before).toBe(0);
  });
});
