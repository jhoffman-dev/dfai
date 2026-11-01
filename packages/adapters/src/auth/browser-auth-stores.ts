import type { PendingSignInStore, SecureRandom, Sha256 } from '@dfai/application';
import { isWellFormedSignInSecret, type PendingSignIn } from '@dfai/domain';
import type { CrossTabLock } from './function-auth-gateway.ts';

/*
 * The browser's parts of the sign-in (#663, ADR-0052) besides the function:
 * the pending sign-in in this tab's sessionStorage, secure random bytes and
 * SHA-256 from Web Crypto, and the cross-tab lock from the Web Locks API.
 */

export const PENDING_KEY = 'dfai.auth.pending';

/**
 * The pending sign-in, in this tab's sessionStorage: it survives the trip to
 * GitHub and back and no other tab can read it. It is no credential on its
 * own (the verifier redeems nothing without the code and the App's secret).
 */
export function sessionStoragePendingSignIn(storage: Storage): PendingSignInStore {
  return {
    save: (pending) => storage.setItem(PENDING_KEY, JSON.stringify(pending)),
    take: () => {
      let text: string | null;
      try {
        text = storage.getItem(PENDING_KEY);
        storage.removeItem(PENDING_KEY);
      } catch {
        // Storage blocked: no sign-in can have been saved there either, so none is pending.
        return null;
      }
      return text === null ? null : readPending(text);
    },
  };
}

function readPending(text: string): PendingSignIn | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Unreadable is as good as absent: the callback is then a mismatch, as it should be.
    return null;
  }
  const { state, verifier, startedAt } = (value ?? {}) as Record<string, unknown>;
  if (typeof state !== 'string' || typeof verifier !== 'string') return null;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  if (!isWellFormedSignInSecret(state) || !isWellFormedSignInSecret(verifier)) return null;
  return { state, verifier, startedAt };
}

export function webCryptoRandom(crypto: Crypto): SecureRandom {
  return { bytes: (count) => crypto.getRandomValues(new Uint8Array(count)) };
}

export function webCryptoSha256(subtle: SubtleCrypto): Sha256 {
  return {
    digest: async (text) =>
      new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text))),
  };
}

/**
 * The Web Locks API's exclusive lock, or no lock where a browser lacks it
 * (Safari before 15.4): then two tabs refreshing at the same moment may sign
 * one of them out, which a sign-in puts right.
 */
export function webLocks(locks: LockManager | undefined): CrossTabLock {
  if (!locks) return (_name, task) => task();
  return (name, task) => locks.request(name, task);
}
