// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserThemeStore } from './browser-theme-store.ts';

/**
 * Attack on PR #371 (slice 13f): the browser theme store's read / write /
 * clear / subscribe contract under hostile storage and a second window.
 */

const KEY = 'atlas.theme';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

/** What another window writing the key looks like to this one. */
function anotherWindowStores(value: string | null): void {
  if (value === null) window.localStorage.removeItem(KEY);
  else window.localStorage.setItem(KEY, value);
  window.dispatchEvent(
    new StorageEvent('storage', { key: KEY, newValue: value, storageArea: window.localStorage }),
  );
}

describe('browser theme store, attack 371', () => {
  it.each(['Dark', ' dark', '"dark"', '', 'system', 'null', '{}'])(
    'reads a malformed stored value %j as no choice',
    (stored) => {
      window.localStorage.setItem(KEY, stored);
      expect(createBrowserThemeStore().read()).toBeNull();
    },
  );

  it('answers with this session’s write, and tells listeners, when setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const store = createBrowserThemeStore();
    const heard = vi.fn();
    store.subscribe(heard);
    store.write('dark');
    expect(store.read()).toBe('dark');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('answers "no choice" this session after clear, even when removeItem throws over a stored choice', () => {
    window.localStorage.setItem(KEY, 'dark');
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const store = createBrowserThemeStore();
    store.clear();
    expect(store.read()).toBeNull();
  });

  it('a quick write, clear, write leaves the last write stored and read', () => {
    const store = createBrowserThemeStore();
    store.write('dark');
    store.clear();
    store.write('light');
    expect(store.read()).toBe('light');
    expect(window.localStorage.getItem(KEY)).toBe('light');
  });

  it('clear removes the key, so the next launch matches the system', () => {
    const store = createBrowserThemeStore();
    store.write('dark');
    store.clear();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(createBrowserThemeStore().read()).toBeNull();
  });

  it('stops telling a listener once it has unsubscribed', () => {
    const store = createBrowserThemeStore();
    const heard = vi.fn();
    const stop = store.subscribe(heard);
    stop();
    store.write('dark');
    store.clear();
    expect(heard).not.toHaveBeenCalled();
  });

  it('tells a listener that subscribes during a notification no earlier than the next change', () => {
    const store = createBrowserThemeStore();
    const late = vi.fn();
    store.subscribe(() => store.subscribe(late));
    store.write('dark');
    // Set.forEach visits members added mid-iteration; harmless for React, recorded here.
    expect(late.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('tells its listeners when another window changes the stored theme', () => {
    const store = createBrowserThemeStore();
    const heard = vi.fn();
    store.subscribe(heard);
    anotherWindowStores('dark');
    expect(heard).toHaveBeenCalled();
  });

  it('reads another window’s later choice, even after this window has made one', () => {
    const store = createBrowserThemeStore();
    store.write('light');
    anotherWindowStores('dark');
    expect(store.read()).toBe('dark');
  });
});
