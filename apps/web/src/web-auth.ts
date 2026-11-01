import {
  functionAuthGateway,
  sessionStoragePendingSignIn,
  webCryptoRandom,
  webCryptoSha256,
  webLocks,
} from '@dfai/adapters';
import { createAuthService, type AuthPort } from '@dfai/application';

/**
 * The web build's sign-in with GitHub (#663, ADR-0052), composed from the
 * browser: the function on this origin, the tab's sessionStorage for the
 * pending sign-in, Web Crypto, and Web Locks across tabs.
 */
export function composeWebAuth(page: Window = window): AuthPort {
  return createAuthService({
    gateway: functionAuthGateway({
      fetch: (input, init) => page.fetch(input, init),
      navigate: (url) => page.location.assign(url),
      lock: webLocks(page.navigator.locks),
    }),
    pending: sessionStoragePendingSignIn(page.sessionStorage),
    random: webCryptoRandom(page.crypto),
    sha256: webCryptoSha256(page.crypto.subtle),
    clock: { now: () => Date.now() },
  });
}
