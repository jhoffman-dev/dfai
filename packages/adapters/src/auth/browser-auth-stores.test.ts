import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
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
});
