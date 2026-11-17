// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assistAsks, browserAssistAsks } from './assist-asks-store.ts';

/**
 * #903: Suggest's asks are kept per machine, shared by its windows, pruned to
 * the hour, and still counted in a window whose storage cannot be reached.
 */

const AT = Date.UTC(2026, 10, 17, 9, 0, 0);
const KEY = 'atlas.inboxAssist.asks./vault';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('Suggest’s asks', () => {
  it('are shared by every window on the machine, per vault', () => {
    browserAssistAsks().record('/vault', AT);
    const otherWindow = browserAssistAsks();
    expect(otherWindow.asked('/vault')).toEqual([AT]);
    expect(otherWindow.asked('/other')).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual([AT]);
  });

  it('keep only the last hour, counted back from the newest', () => {
    const asks = browserAssistAsks();
    asks.record('/vault', AT - 3_600_000);
    asks.record('/vault', AT - 60_000);
    asks.record('/vault', AT);
    expect(asks.asked('/vault')).toEqual([AT - 60_000, AT]);
  });

  it('read a stored value that is not a list of times as none', () => {
    window.localStorage.setItem(KEY, '{"at": 1}');
    expect(browserAssistAsks().asked('/vault')).toEqual([]);
    window.localStorage.setItem(KEY, '[1, "2", null, 3]');
    expect(browserAssistAsks().asked('/vault')).toEqual([1, 3]);
    window.localStorage.setItem(KEY, 'not json');
    expect(browserAssistAsks().asked('/vault')).toEqual([]);
  });

  it('are still counted in this window when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const asks = browserAssistAsks();
    asks.record('/vault', AT);
    expect(asks.asked('/vault')).toEqual([AT]);
  });

  it('are kept in memory alone when given no storage', () => {
    const asks = assistAsks();
    asks.record('/vault', AT);
    expect(asks.asked('/vault')).toEqual([AT]);
    expect(assistAsks().asked('/vault')).toEqual([]);
  });
});
