// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import { withQuery } from './overlay.ts';
import {
  changePalette,
  closePeek,
  createOverlayStore,
  followPeekMove,
  forgetPeeked,
  hideOverlay,
  openPeek,
  overlayNow,
  peekNow,
  replacePeek,
  showOverlay,
  stepPeek,
  usePeek,
  useOverlayUp,
  usePaletteInput,
  useWindowOverlay,
} from './overlay-store.ts';

describe('the overlay store', () => {
  it('puts up one overlay at a time, and a palette holds off another', () => {
    const store = createOverlayStore();
    showOverlay(store, 'new-note-menu');
    showOverlay(store, 'search');
    expect(overlayNow(store)).toBe('search');
    showOverlay(store, 'capture');
    expect(overlayNow(store)).toBe('search');
    hideOverlay(store, 'capture');
    expect(overlayNow(store)).toBe('search');
    hideOverlay(store, 'search');
    expect(overlayNow(store)).toBeNull();
  });

  it('opens the search palette empty after it closed with something typed', () => {
    const store = createOverlayStore();
    showOverlay(store, 'search');
    changePalette(store, (input) => withQuery(input, 'sourd'));
    hideOverlay(store, 'search');
    showOverlay(store, 'search');
    expect(store.getState().palette.query).toBe('');
  });

  it('does not draw what the window draws as ⌘K opens and takes keys, only the palette', () => {
    const store = createOverlayStore();
    let windowDrawn = 0;
    let paletteDrawn = 0;
    const shown = renderHook(() => {
      windowDrawn += 1;
      return useWindowOverlay(store);
    });
    const typedInto = renderHook(() => {
      paletteDrawn += 1;
      return { up: useOverlayUp(store, 'search'), input: usePaletteInput(store) };
    });
    const [windowBefore, paletteBefore] = [windowDrawn, paletteDrawn];

    act(() => showOverlay(store, 'search'));
    for (const query of ['s', 'so', 'sou', 'sour', 'sourd']) {
      act(() => changePalette(store, (input) => withQuery(input, query)));
    }

    expect(typedInto.result.current).toEqual({
      up: true,
      input: { query: 'sourd', selected: 0, includeArchived: false, byMeaning: false },
    });
    expect(paletteDrawn - paletteBefore).toBe(6);
    expect(shown.result.current).toBeNull();
    expect(windowDrawn - windowBefore).toBe(0);
  });

  it('draws the window again for an overlay it draws itself (control)', () => {
    const store = createOverlayStore();
    const shown = renderHook(() => useWindowOverlay(store));
    act(() => showOverlay(store, 'settings'));
    expect(shown.result.current).toBe('settings');
  });

  it('steps, replaces and closes the peek, and follows its note', () => {
    const store = createOverlayStore();
    const order = ['a.md', 'b.md'].map(createVaultPath);
    openPeek(store, { path: order[0]!, from: { within: 'Tasks', order, index: 0 } });
    stepPeek(store, 1);
    expect(peekNow(store)?.path).toBe('b.md');
    followPeekMove(store, { from: createVaultPath('b.md'), to: createVaultPath('c.md') });
    expect(peekNow(store)?.path).toBe('c.md');
    replacePeek(store, createVaultPath('d.md'));
    expect(peekNow(store)).toEqual({ path: 'd.md', from: null });
    forgetPeeked(store, [createVaultPath('d.md')]);
    expect(peekNow(store)).toBeNull();
    openPeek(store, { path: order[0]!, from: null });
    showOverlay(store, 'new-note-menu');
    closePeek(store);
    expect(store.getState()).toEqual(createOverlayStore().getState());
  });

  it("draws only the peek's reader as the peek opens and steps, not what the window draws", () => {
    const store = createOverlayStore();
    let windowDrawn = 0;
    const shown = renderHook(() => {
      windowDrawn += 1;
      return useWindowOverlay(store);
    });
    const peek = renderHook(() => usePeek(store));
    const before = windowDrawn;
    const order = ['a.md', 'b.md'].map(createVaultPath);
    act(() => openPeek(store, { path: order[0]!, from: { within: 'Tasks', order, index: 0 } }));
    act(() => stepPeek(store, 1));
    expect(peek.result.current?.path).toBe('b.md');
    expect(shown.result.current).toBeNull();
    expect(windowDrawn - before).toBe(0);
  });
});
