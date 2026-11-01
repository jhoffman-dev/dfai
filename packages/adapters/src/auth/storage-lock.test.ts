import { describe, expect, it } from 'vitest';
import { HOLD_MS, POLL_MS, SETTLE_MS, storageLock, type StorageLockDeps } from './storage-lock.ts';

/**
 * #663, PR #704's attack: the localStorage lock for browsers without Web
 * Locks, with tabs sharing one storage and a clock and waits of the test's.
 */

function memoryStorage(): Storage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
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

/** A browser's tabs: one storage, one clock that waits move on, and each tab's own name. */
function browser() {
  const storage = memoryStorage();
  let now = 1_000;
  const waits: number[] = [];
  let ids = 0;
  const deps = (over: Partial<StorageLockDeps> = {}): StorageLockDeps => ({
    storage,
    now: () => now,
    holderId: () => `tab-${(ids += 1)}`,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
      // Let the other tab's step run, as the event loop would.
      await new Promise((resolve) => setImmediate(resolve));
    },
    ...over,
  });
  return { storage, deps, waits, advance: (ms: number) => (now += ms) };
}

const KEY = 'dfai.lock.refresh';

describe('the localStorage lock', () => {
  it('runs one task at a time across tabs, in turn', async () => {
    const { deps } = browser();
    const [a, b] = [storageLock(deps()), storageLock(deps())];
    const order: string[] = [];
    const task = (who: string) => async () => {
      order.push(`${who} in`);
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`${who} out`);
      return who;
    };
    expect(await Promise.all([a('refresh', task('a')), b('refresh', task('b'))])).toEqual([
      'a',
      'b',
    ]);
    expect(order).toEqual(['a in', 'a out', 'b in', 'b out']);
  });

  it('confirms its claim after a moment, and lets go when done', async () => {
    const { deps, storage, waits } = browser();
    let held: unknown = null;
    await storageLock(deps())('refresh', async () => {
      held = JSON.parse(storage.getItem(KEY) ?? 'null');
    });
    expect(held).toEqual({ holder: 'tab-1', until: 1_000 + HOLD_MS });
    expect(waits).toEqual([SETTLE_MS]);
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('backs off when another tab’s write landed over its claim', async () => {
    const { deps, storage } = browser();
    let overwritten = false;
    const racing = deps({
      wait: async (ms) => {
        // Another tab writes its own claim during the settle: the later write wins.
        if (!overwritten && ms === SETTLE_MS) {
          overwritten = true;
          storage.setItem(KEY, JSON.stringify({ holder: 'other', until: 1_000 + 50 }));
        }
        await new Promise((resolve) => setImmediate(resolve));
      },
      now: () => (clock += 20),
    });
    let clock = 1_000;
    let startedAt = 0;
    await storageLock(racing)('refresh', async () => void (startedAt = clock));
    expect(overwritten).toBe(true);
    // It waited for the other tab's hold to lapse rather than running beside it.
    expect(startedAt).toBeGreaterThan(1_050);
  });

  it('takes over a hold that lapsed, as from a tab closed mid-refresh', async () => {
    const { deps, storage, waits } = browser();
    storage.setItem(KEY, JSON.stringify({ holder: 'closed', until: 1_000 + 2 * POLL_MS }));
    expect(await storageLock(deps())('refresh', async () => 'ran')).toBe('ran');
    expect(waits.filter((ms) => ms === POLL_MS).length).toBeGreaterThanOrEqual(2);
  });

  it('takes over a key it cannot read', async () => {
    const { deps, storage } = browser();
    storage.setItem(KEY, '{not json');
    expect(await storageLock(deps())('refresh', async () => 'ran')).toBe('ran');
  });

  it('leaves a hold that is no longer its own when done', async () => {
    const { deps, storage } = browser();
    await storageLock(deps())('refresh', async () => {
      storage.setItem(KEY, JSON.stringify({ holder: 'next', until: 9e15 }));
    });
    expect(JSON.parse(storage.getItem(KEY) ?? 'null')).toMatchObject({ holder: 'next' });
  });

  it('lets go when the task fails, and passes the failure on', async () => {
    const { deps, storage } = browser();
    await expect(
      storageLock(deps())('refresh', async () => {
        throw new Error('refresh failed');
      }),
    ).rejects.toThrow('refresh failed');
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('wakes on the storage event rather than waiting out the poll', async () => {
    const { deps, storage } = browser();
    storage.setItem(KEY, JSON.stringify({ holder: 'other', until: 1_000 + HOLD_MS }));
    const target = new EventTarget();
    let polls = 0;
    const lock = storageLock(
      deps({
        events: target as unknown as Window,
        wait: (ms) =>
          ms === POLL_MS
            ? new Promise(() => void (polls += 1)) // a poll that never ends
            : new Promise((resolve) => setImmediate(resolve)),
      }),
    );
    const running = lock('refresh', async () => 'ran');
    await new Promise((resolve) => setImmediate(resolve));
    storage.removeItem(KEY);
    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'unrelated' }));
    target.dispatchEvent(Object.assign(new Event('storage'), { key: KEY }));
    expect(await running).toBe('ran');
    expect(polls).toBeGreaterThanOrEqual(1);
  });

  it('runs the task unlocked when storage refuses the write', async () => {
    const { deps, storage } = browser();
    const full = {
      ...storage,
      getItem: storage.getItem,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    };
    expect(await storageLock(deps({ storage: full }))('refresh', async () => 'ran')).toBe('ran');
  });
});
