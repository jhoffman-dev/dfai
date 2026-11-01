import { describe, expect, it } from 'vitest';
import { HOLD_MS, storageLock } from './storage-lock.ts';

/**
 * #663, PR #704's third attack: a hold left by a closed tab must lapse within
 * HOLD_MS of now. A hold's `until` is the writer's Date.now + HOLD_MS; when the
 * wall clock is then set back (NTP correcting a fast clock, a person fixing
 * the time) the stale hold lies further ahead than any hold could, and every
 * tab waits it out before it may refresh or sign out.
 */

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    key: () => null,
    getItem: (key) => items.get(key) ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

describe('a stale hold from a closed tab after the clock went back', () => {
  it('lapses within HOLD_MS, not after the clock catches up', async () => {
    const storage = memoryStorage();
    let now = 1_000_000;
    // Written by a tab that closed mid-refresh, when the clock read an hour ahead.
    storage.setItem(
      'dfai.lock.refresh',
      JSON.stringify({ holder: 'closed-tab', until: now + 60 * 60_000 + HOLD_MS }),
    );
    const lock = storageLock({
      storage,
      now: () => now,
      holderId: () => 'this-tab',
      wait: async (ms) => {
        now += ms;
        await Promise.resolve();
      },
    });
    const startedAt = now;
    await lock('refresh', async () => undefined);
    // Observed: about an hour and 30 s of waiting.
    expect(now - startedAt).toBeLessThanOrEqual(HOLD_MS + 1_000);
  });
});
