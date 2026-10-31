// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserImagePlacementStore } from './browser-image-placement-store.ts';

const KEY = 'atlas.imagePlacement';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('the image placement store', () => {
  it('is the attachments folder until something else is chosen', () => {
    expect(createBrowserImagePlacementStore().read()).toBe('attachments');
  });

  it('keeps a choice across launches', () => {
    createBrowserImagePlacementStore().write('beside-note');
    expect(window.localStorage.getItem(KEY)).toBe('beside-note');
    expect(createBrowserImagePlacementStore().read()).toBe('beside-note');
  });

  it('reads the default rather than trusting a value it does not recognise', () => {
    window.localStorage.setItem(KEY, 'desktop');
    expect(createBrowserImagePlacementStore().read()).toBe('attachments');
  });

  it('keeps the choice for the session where storage refuses it', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('The operation is insecure.');
    });
    const store = createBrowserImagePlacementStore();
    expect(store.read()).toBe('attachments');
    store.write('beside-note');
    expect(store.read()).toBe('beside-note');
  });
});
