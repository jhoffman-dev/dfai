// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserAssistAsks } from './assist-asks-store.ts';

/**
 * Adversarial second pass on #903 (#900): Suggest's kept asks still count
 * when storage half-works.
 */

const AT = Date.UTC(2026, 10, 17, 9, 0, 0);
const KEY = 'atlas.inboxAssist.asks./vault';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('attack2-903: storage that reads but will not write', () => {
  it('still counts every ask this window makes', () => {
    // An earlier ask is stored; then storage is full (setItem throws, getItem works).
    window.localStorage.setItem(KEY, JSON.stringify([AT - 30 * 60_000]));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const asks = browserAssistAsks();
    for (let n = 1; n <= 5; n += 1) asks.record('/vault', AT + n * 1_000);
    expect(asks.asked('/vault')).toHaveLength(6);
  });
});

describe('attack2-903: pinned behaviour (expected to pass)', () => {
  it('reads a corrupt stored value as no asks at all', () => {
    window.localStorage.setItem(KEY, '[1700000000000, ');
    expect(browserAssistAsks().asked('/vault')).toEqual([]);
  });
});
