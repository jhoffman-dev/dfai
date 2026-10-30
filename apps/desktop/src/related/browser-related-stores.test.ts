// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserRelatedPanelMemory,
  createBrowserDismissedRelatedStore,
} from './browser-related-stores.ts';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('the dismissed related notes', () => {
  it('keeps each note’s dismissals across launches, per vault, once each', () => {
    const store = createBrowserDismissedRelatedStore('/vault');
    store.dismiss('Plan.md', 'Garden.md');
    store.dismiss('Plan.md', 'Garden.md');
    store.dismiss('Plan.md', 'Bees.md');
    expect([...createBrowserDismissedRelatedStore('/vault').dismissed('Plan.md')]).toEqual([
      'Garden.md',
      'Bees.md',
    ]);
    expect(createBrowserDismissedRelatedStore('/other').dismissed('Plan.md').size).toBe(0);
    expect(createBrowserDismissedRelatedStore('/vault').dismissed('Budget.md').size).toBe(0);
  });

  it('reads what it does not recognise as nothing dismissed', () => {
    window.localStorage.setItem(
      'atlas.related-dismissed:/vault',
      '{"Plan.md": ["Garden.md", 3], "Budget.md": "Bees.md"}',
    );
    const store = createBrowserDismissedRelatedStore('/vault');
    expect([...store.dismissed('Plan.md')]).toEqual(['Garden.md']);
    expect(store.dismissed('Budget.md').size).toBe(0);
    window.localStorage.setItem('atlas.related-dismissed:/vault', '[1]');
    expect(createBrowserDismissedRelatedStore('/vault').dismissed('Plan.md').size).toBe(0);
    window.localStorage.setItem('atlas.related-dismissed:/vault', '{');
    expect(createBrowserDismissedRelatedStore('/vault').dismissed('Plan.md').size).toBe(0);
  });

  it('holds a dismissal for the session where storage refuses it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const store = createBrowserDismissedRelatedStore('/vault');
    store.dismiss('Plan.md', 'Garden.md');
    expect([...store.dismissed('Plan.md')]).toEqual(['Garden.md']);
  });
});

describe('whether the Related notes section is left open', () => {
  it('is shut until opened, and remembers either way', () => {
    expect(browserRelatedPanelMemory.isOpen()).toBe(false);
    browserRelatedPanelMemory.setOpen(true);
    expect(browserRelatedPanelMemory.isOpen()).toBe(true);
    browserRelatedPanelMemory.setOpen(false);
    expect(browserRelatedPanelMemory.isOpen()).toBe(false);
  });

  it('reads as shut, and says nothing, where storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => browserRelatedPanelMemory.setOpen(true)).not.toThrow();
    expect(browserRelatedPanelMemory.isOpen()).toBe(false);
  });
});
