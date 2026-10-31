// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserMacId } from './browser-mac-id.ts';
import { browserSyncPause } from './browser-sync-pause.ts';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

/** Storage that throws, as it does where site data is blocked. */
function blockStorage() {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('blocked');
  });
}

describe('browserMacId', () => {
  it('makes this Mac’s id once, and keeps it from then on', async () => {
    const make = vi.fn().mockReturnValueOnce('mac-1').mockReturnValueOnce('mac-2');
    await expect(browserMacId(make)()).resolves.toBe('mac-1');
    // A later launch reads the same id back, and makes none.
    await expect(browserMacId(make)()).resolves.toBe('mac-1');
    expect(make).toHaveBeenCalledOnce();
  });

  it('lasts the session when storage is out of reach, rather than failing', async () => {
    blockStorage();
    const make = vi.fn().mockReturnValueOnce('mac-session').mockReturnValueOnce('mac-other');
    const id = browserMacId(make);
    await expect(id()).resolves.toBe('mac-session');
    await expect(id()).resolves.toBe('mac-session');
    expect(make).toHaveBeenCalledOnce();
  });
});

describe('browserSyncPause', () => {
  it('keeps the pause per vault, on this Mac', () => {
    expect(browserSyncPause.read('/Users/j/Notes')).toBe(false);
    browserSyncPause.write('/Users/j/Notes', true);
    expect(browserSyncPause.read('/Users/j/Notes')).toBe(true);
    expect(browserSyncPause.read('/Users/j/Work')).toBe(false);
    browserSyncPause.write('/Users/j/Notes', false);
    expect(browserSyncPause.read('/Users/j/Notes')).toBe(false);
  });

  it('reads as not paused, and writes nothing, when storage is out of reach', () => {
    blockStorage();
    expect(browserSyncPause.read('/Users/j/Notes')).toBe(false);
    expect(() => browserSyncPause.write('/Users/j/Notes', true)).not.toThrow();
  });
});
