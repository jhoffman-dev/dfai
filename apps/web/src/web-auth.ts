import {
  broadcastChannelAuth,
  functionAuthGateway,
  sessionStoragePendingSignIn,
  storageLock,
  webCryptoRandom,
  webCryptoSha256,
  webLocks,
} from '@dfai/adapters';
import { createAuthService, type AuthPort } from '@dfai/application';
import { base64url } from '@dfai/domain';

/**
 * The web build's sign-in with GitHub (#663, ADR-0052), composed from the
 * browser: the function on this origin, the tab's sessionStorage for the
 * pending sign-in, Web Crypto, Web Locks across tabs (a localStorage lock
 * where there are none), and a BroadcastChannel to tell the other tabs of a
 * sign-out.
 */
export function composeWebAuth(page: Window = window): AuthPort {
  const wait = (ms: number) => new Promise<void>((resolve) => page.setTimeout(resolve, ms));
  const fallback = storageLock({
    storage: page.localStorage,
    events: page,
    now: () => Date.now(),
    // Not randomUUID: the browsers that need this lock (Safari before 15.4) lack it.
    holderId: () => base64url(page.crypto.getRandomValues(new Uint8Array(16))),
    wait,
  });
  return createAuthService({
    gateway: functionAuthGateway({
      fetch: (input, init) => page.fetch(input, init),
      navigate: (url) => page.location.assign(url),
      lock: webLocks(page.navigator.locks, fallback),
      delay: wait,
    }),
    pending: sessionStoragePendingSignIn(page.sessionStorage),
    random: webCryptoRandom(page.crypto),
    sha256: webCryptoSha256(page.crypto.subtle),
    // The wall clock: Safari stops performance.now() while the device sleeps, which would keep
    // a token past its expiry. A wall clock set back is caught where a token is refused (one
    // refresh, then signed out) and a pending sign-in that seems to start in the future is stale.
    clock: { now: () => Date.now() },
    broadcast: broadcastChannelAuth(
      typeof BroadcastChannel === 'function' ? (name) => new BroadcastChannel(name) : undefined,
    ),
  });
}
