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

  it('read a stored value that is not a list of times as unknown, and count this window’s own', () => {
    window.localStorage.setItem(KEY, '[1, "2", null, 3]');
    expect(browserAssistAsks().asked('/vault')).toEqual([]);
    const asks = browserAssistAsks();
    asks.record('/vault', AT);
    window.localStorage.setItem(KEY, 'not json');
    expect(asks.asked('/vault')).toEqual([AT]);
  });

  it('count a time kept while the clock ran fast as now, and let it age out', () => {
    const asks = browserAssistAsks();
    for (let n = 0; n < 3; n += 1) asks.record('/vault', AT + 24 * 3_600_000);
    expect(asks.asked('/vault', AT)).toEqual([AT, AT, AT]);
    // Kept as now: another window reads them so, and an hour on they are gone.
    expect(browserAssistAsks().asked('/vault')).toEqual([AT, AT, AT]);
    asks.record('/vault', AT + 3_600_000 + 1_000);
    expect(asks.asked('/vault')).toEqual([AT + 3_600_000 + 1_000]);
  });

  it('record a time ahead of the ask as the ask’s own', () => {
    const asks = browserAssistAsks();
    window.localStorage.setItem(KEY, JSON.stringify([AT + 60_000]));
    asks.record('/vault', AT);
    expect(asks.asked('/vault')).toEqual([AT, AT]);
  });

  it('take back a claimed ask that was never sent, and only that one', () => {
    const asks = browserAssistAsks();
    asks.record('/vault', AT - 1_000);
    asks.record('/vault', AT);
    asks.withdraw('/vault', AT);
    asks.withdraw('/vault', AT + 5);
    expect(browserAssistAsks().asked('/vault')).toEqual([AT - 1_000]);
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
