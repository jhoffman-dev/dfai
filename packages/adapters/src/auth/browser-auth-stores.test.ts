import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  broadcastChannelAuth,
  PENDING_KEY,
  sessionStoragePendingSignIn,
  webCryptoRandom,
  webCryptoSha256,
  webLocks,
} from './browser-auth-stores.ts';

/** #663, ADR-0052: the pending sign-in's storage, Web Crypto, and the cross-tab lock. */

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

const pending = { state: 's'.repeat(43), verifier: 'v'.repeat(43), startedAt: 5 };

describe('the pending sign-in in sessionStorage', () => {
  it('round-trips, and is gone once taken', () => {
    const storage = memoryStorage();
    const store = sessionStoragePendingSignIn(storage);
    store.save(pending);
    expect(store.take()).toEqual(pending);
    expect(storage.getItem(PENDING_KEY)).toBeNull();
    expect(store.take()).toBeNull();
  });

  it.each([
    ['not JSON', '{'],
    ['null', 'null'],
    ['a short state', JSON.stringify({ ...pending, state: 'abc' })],
    ['a verifier with a space', JSON.stringify({ ...pending, verifier: `${'v'.repeat(43)} ` })],
    ['no start', JSON.stringify({ state: pending.state, verifier: pending.verifier })],
    ['a start that is not a number', JSON.stringify({ ...pending, startedAt: 'now' })],
  ])('reads %s as none pending, and removes it', (_what, text) => {
    const storage = memoryStorage();
    storage.setItem(PENDING_KEY, text);
    expect(sessionStoragePendingSignIn(storage).take()).toBeNull();
    expect(storage.getItem(PENDING_KEY)).toBeNull();
  });

  it('reads blocked storage as none pending', () => {
    const blocked = {
      ...memoryStorage(),
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    expect(sessionStoragePendingSignIn(blocked).take()).toBeNull();
  });

  it('lets a failure to save stop the sign-in, rather than leave without a state', () => {
    const full = {
      ...memoryStorage(),
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    };
    expect(() => sessionStoragePendingSignIn(full).save(pending)).toThrow(/full/);
  });
});

describe('Web Crypto', () => {
  it('draws as many bytes as asked, differently each time', () => {
    const random = webCryptoRandom(webcrypto as Crypto);
    const [a, b] = [random.bytes(32), random.bytes(32)];
    expect(a).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('hashes RFC 7636’s example verifier to its digest', async () => {
    const digest = await webCryptoSha256(webcrypto.subtle as SubtleCrypto).digest(
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    );
    expect(Buffer.from(digest).toString('base64url')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('the cross-tab lock', () => {
  it('holds the named lock while the task runs', async () => {
    const requested: string[] = [];
    const locks = {
      request: (name: string, task: () => Promise<unknown>) => {
        requested.push(name);
        return task();
      },
    } as unknown as LockManager;
    expect(await webLocks(locks)('the-lock', async () => 42)).toBe(42);
    expect(requested).toEqual(['the-lock']);
  });

  it('runs the task as it is where the browser has no locks', async () => {
    expect(await webLocks(undefined)('the-lock', async () => 'ran')).toBe('ran');
  });

  it('takes the fallback where the browser has no locks, and only there', async () => {
    const used: string[] = [];
    const fallback = <T>(name: string, task: () => Promise<T>) => {
      used.push(name);
      return task();
    };
    await webLocks(undefined, fallback)('the-lock', async () => 'ran');
    const locks = { request: (_n: string, task: () => Promise<unknown>) => task() };
    await webLocks(locks as unknown as LockManager, fallback)('other', async () => 'ran');
    expect(used).toEqual(['the-lock']);
  });
});

describe('telling the other tabs', () => {
  it('reaches another tab on the channel, which hears only a sign-out', async () => {
    const open = (name: string) => new BroadcastChannel(name);
    const a = broadcastChannelAuth(open);
    const b = broadcastChannelAuth(open);
    let heard = 0;
    const stop = b.onSignOut(() => (heard += 1));
    const stranger = new BroadcastChannel('dfai-auth');
    stranger.postMessage('something else');
    a.announceSignOut();
    await vi.waitFor(() => expect(heard).toBe(1));
    stop();
    a.announceSignOut();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard).toBe(1);
    stranger.close();
  });

  it('tells nobody, and fails nothing, where there is no BroadcastChannel', () => {
    const none = broadcastChannelAuth(undefined);
    expect(() => none.announceSignOut()).not.toThrow();
    expect(none.onSignOut(() => {})).toBeTypeOf('function');
  });
});
