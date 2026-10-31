// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThemeStore } from '@dfai/ui';
import { browserThemeStore, createBrowserThemeStore } from './browser-theme-store.ts';

const KEY = 'atlas.theme';

/** Replaces `window.localStorage` for one test. */
const withStorage = (storage: Partial<Storage>) => {
  vi.spyOn(window, 'localStorage', 'get').mockReturnValue(storage as Storage);
};

/** The accessor itself throws in a private window, before any method is called. */
const withDeniedStorage = () => {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('The operation is insecure.');
  });
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('browserThemeStore', () => {
  // A fresh store for each test: a store remembers this session's choice
  // itself, so one shared between tests would answer with the last test's.
  let store: ThemeStore;
  beforeEach(() => {
    store = createBrowserThemeStore();
  });

  it('round-trips a choice', () => {
    store.write('dark');
    expect(store.read()).toBe('dark');
    expect(window.localStorage.getItem(KEY)).toBe('dark');
  });

  it('is what the app is handed', () => {
    window.localStorage.setItem(KEY, 'light');
    expect(browserThemeStore.read()).toBe('light');
  });

  it('reads nothing when no choice has been made', () => {
    expect(store.read()).toBeNull();
  });

  it('reads nothing rather than trusting a value it does not recognise', () => {
    window.localStorage.setItem(KEY, 'solarized');
    expect(store.read()).toBeNull();
  });

  it('reads nothing when the accessor throws, as in a private window', () => {
    withDeniedStorage();
    expect(store.read()).toBeNull();
  });

  it('reads nothing when the read itself throws', () => {
    withStorage({
      getItem: () => {
        throw new Error('denied');
      },
    });
    expect(store.read()).toBeNull();
  });

  it('swallows a write the browser refuses, so the app carries on', () => {
    withDeniedStorage();
    expect(() => store.write('dark')).not.toThrow();
  });

  it('swallows a write that fails on quota', () => {
    withStorage({
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(() => store.write('light')).not.toThrow();
  });

  it('forgets a choice on clear, so nothing is stored and the read is null', () => {
    store.write('dark');
    store.clear();
    expect(store.read()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('tells its listeners of each write and clear, until they stop listening', () => {
    const heard = vi.fn();
    const stop = store.subscribe(heard);
    store.write('dark');
    store.clear();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    store.write('light');
    expect(heard).toHaveBeenCalledTimes(2);
  });

  // The choice lives in the store (theme.ts): both the sidebar's button and
  // Settings read it back, so a write the browser refuses must still be read
  // back for this session, as the image placement store does.
  it('still answers with this session’s choice when the browser refused to keep it', () => {
    withDeniedStorage();
    store.write('dark');
    expect(store.read()).toBe('dark');
  });

  it('still reads as cleared this session when the browser refused to forget', () => {
    window.localStorage.setItem(KEY, 'dark');
    expect(store.read()).toBe('dark');
    withStorage({
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => store.clear()).not.toThrow();
    expect(store.read()).toBeNull();
  });

  // Review of 05abaa6a: clearing sessionStorage sends a `storage` event with
  // a null key too, and that one says nothing about the theme.
  it('ignores a storage event from a store that is not localStorage', () => {
    store.write('dark');
    const heard = vi.fn();
    store.subscribe(heard);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: null,
        newValue: null,
        storageArea: window.sessionStorage,
      }),
    );
    expect(heard).not.toHaveBeenCalled();
    expect(store.read()).toBe('dark');
  });
});
