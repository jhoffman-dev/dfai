import type { AuthFailureKind, PendingSignIn, TokenGrant } from '@dfai/domain';
import {
  AuthError,
  type AuthBroadcast,
  type AuthGateway,
  type PendingSignInStore,
  type SecureRandom,
  type Sha256,
} from '../auth/ports.ts';

/** One call the fake sign-in function heard. */
export type AuthGatewayCall =
  | { readonly kind: 'start'; readonly state: string; readonly codeChallenge: string }
  | { readonly kind: 'exchange'; readonly code: string; readonly verifier: string }
  | { readonly kind: 'refresh' }
  | { readonly kind: 'sign-out'; readonly accessToken: string | null };

export interface FakeAuthGateway extends AuthGateway {
  readonly calls: AuthGatewayCall[];
  /** Whether the browser holds the function's refresh cookie. */
  hasCookie: boolean;
  /** The App's access was removed on GitHub: refreshes fail as revoked. */
  revoked: boolean;
  /** The codes GitHub would accept, each once. */
  readonly codes: Set<string>;
  /** Fails every call with this kind until cleared (`network`: the function is unreachable). */
  failWith: AuthFailureKind | null;
  /** How long each token it grants lives. */
  expiresInSeconds: number;
  /** Holds each refresh until `release()`, to put two calls in flight at once. */
  holdRefreshes: boolean;
  release(): void;
}

/**
 * The sign-in function and GitHub behind it, in memory: codes are good once,
 * a refresh needs the cookie and rotates it, revocation fails refreshes, and
 * each token granted is numbered so a test can tell them apart.
 */
export function fakeAuthGateway(): FakeAuthGateway {
  let issued = 0;
  const held: (() => void)[] = [];
  const grant = (): TokenGrant => {
    issued += 1;
    fake.hasCookie = true;
    return { accessToken: `ghu_token${issued}`, expiresInSeconds: fake.expiresInSeconds };
  };
  const failing = () => {
    if (fake.failWith) throw new AuthError(fake.failWith);
  };
  const fake: FakeAuthGateway = {
    calls: [],
    hasCookie: false,
    revoked: false,
    codes: new Set(),
    failWith: null,
    expiresInSeconds: 8 * 60 * 60,
    holdRefreshes: false,
    release: () => held.splice(0).forEach((go) => go()),
    start: ({ state, codeChallenge }) => {
      fake.calls.push({ kind: 'start', state, codeChallenge });
    },
    exchange: async ({ code, verifier }) => {
      fake.calls.push({ kind: 'exchange', code, verifier });
      failing();
      if (!fake.codes.delete(code)) throw new AuthError('bad-code');
      return grant();
    },
    refresh: async () => {
      fake.calls.push({ kind: 'refresh' });
      if (fake.holdRefreshes) await new Promise<void>((go) => held.push(go));
      failing();
      if (!fake.hasCookie) throw new AuthError('no-session');
      // The cookie is kept, as the function keeps it: another tab may have just replaced it.
      if (fake.revoked) throw new AuthError('revoked');
      return grant();
    },
    signOut: async ({ accessToken }) => {
      fake.calls.push({ kind: 'sign-out', accessToken });
      failing();
      fake.hasCookie = false;
    },
  };
  return fake;
}

/** A tab's pending sign-in, in memory. */
export function memoryPendingSignIn(): PendingSignInStore & { held: PendingSignIn | null } {
  const store = {
    held: null as PendingSignIn | null,
    save: (pending: PendingSignIn) => {
      store.held = pending;
    },
    take: () => {
      const pending = store.held;
      store.held = null;
      return pending;
    },
  };
  return store;
}

/** Repeatable "random" bytes: each draw is the next run of a counter. Never for real use. */
export function countingRandom(): SecureRandom {
  let next = 0;
  return {
    bytes: (count) =>
      Uint8Array.from({ length: count }, () => {
        next = (next + 1) & 0xff;
        return next;
      }),
  };
}

/** A stand-in hash that is visibly the verifier's, so a test can see which was sent. */
export const fakeSha256: Sha256 = {
  digest: async (text) => new TextEncoder().encode(`sha256(${text})`),
};

/**
 * A browser's tabs in memory, as BroadcastChannel joins them: a tab's
 * announcement reaches every other tab, never itself.
 */
export function memoryAuthChannel(): { tab(): AuthBroadcast } {
  const tabs = new Set<Set<() => void>>();
  return {
    tab: () => {
      const listeners = new Set<() => void>();
      tabs.add(listeners);
      return {
        announceSignOut: () => {
          for (const other of tabs)
            if (other !== listeners) for (const listener of [...other]) listener();
        },
        onSignOut: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
  };
}
