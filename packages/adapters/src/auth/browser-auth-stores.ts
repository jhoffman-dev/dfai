import type { AuthBroadcast, PendingSignInStore, SecureRandom, Sha256 } from '@dfai/application';
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
 * The Web Locks API's exclusive lock; where a browser lacks it (Safari
 * before 15.4), `fallback` (storageLock), or none at all when not given.
 */
export function webLocks(locks: LockManager | undefined, fallback?: CrossTabLock): CrossTabLock {
  if (locks) return (name, task) => locks.request(name, task);
  return fallback ?? ((_name, task) => task());
}

/** The channel the web build's tabs tell each other of a sign-out on. */
export const AUTH_CHANNEL = 'dfai-auth';
const SIGNED_OUT = 'signed-out';

/**
 * The browser's other tabs, over a BroadcastChannel. A browser without one
 * tells nobody: its other tabs keep their sessions until their next refresh
 * finds the cookie gone.
 */
export function broadcastChannelAuth(
  open: ((name: string) => BroadcastChannel) | undefined,
): AuthBroadcast {
  const channel = open?.(AUTH_CHANNEL);
  return {
    announceSignOut: () => channel?.postMessage(SIGNED_OUT),
    onSignOut: (listener) => {
      const onMessage = (event: MessageEvent) => {
        if (event.data === SIGNED_OUT) listener();
      };
      channel?.addEventListener('message', onMessage);
      return () => channel?.removeEventListener('message', onMessage);
    },
  };
}
