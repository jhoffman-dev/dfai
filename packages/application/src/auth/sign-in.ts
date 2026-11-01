import {
  base64url,
  newPendingSignIn,
  readSignInCallback,
  sessionFromGrant,
  SIGN_IN_SECRET_BYTES,
  type AuthFailureKind,
  type AuthSession,
  type TokenGrant,
} from '@dfai/domain';
import type { Clock } from '../ports.ts';
import {
  AuthError,
  type AuthBroadcast,
  type AuthGateway,
  type PendingSignInStore,
  type SecureRandom,
  type Sha256,
} from './ports.ts';

/** What the sign-in's use-cases need. */
export interface AuthDeps {
  readonly gateway: AuthGateway;
  readonly pending: PendingSignInStore;
  readonly random: SecureRandom;
  readonly sha256: Sha256;
  readonly clock: Pick<Clock, 'now'>;
  /** The other tabs; absent where there are none to tell. */
  readonly broadcast?: AuthBroadcast;
}

/** A session, or why there is none (null: none was ever asked for). */
export type SessionOutcome =
  { readonly session: AuthSession } | { readonly failure: AuthFailureKind | null };

/**
 * Starts a sign-in (#663): new state and PKCE verifier, kept in this tab for
 * the callback, then off to GitHub with the verifier's S256 challenge.
 */
export async function startSignIn(deps: AuthDeps): Promise<void> {
  const pending = newPendingSignIn({
    stateBytes: deps.random.bytes(SIGN_IN_SECRET_BYTES),
    verifierBytes: deps.random.bytes(SIGN_IN_SECRET_BYTES),
    now: deps.clock.now(),
  });
  deps.pending.save(pending);
  const codeChallenge = base64url(await deps.sha256.digest(pending.verifier));
  deps.gateway.start({ state: pending.state, codeChallenge });
}

/**
 * The session a gateway call grants. The lifetime is counted from before the
 * call, so the session never believes its token lives longer than it does.
 */
export async function redeemGrant(
  deps: AuthDeps,
  grant: () => Promise<TokenGrant>,
): Promise<SessionOutcome> {
  const askedAt = deps.clock.now();
  try {
    const session = sessionFromGrant(await grant(), askedAt);
    return session ? { session } : { failure: 'malformed' };
  } catch (error) {
    if (error instanceof AuthError) return { failure: error.kind };
    throw error;
  }
}

/**
 * The session a page starts with: GitHub's callback redeemed when the query
 * is one, else the function's cookie. A callback that fails still tries the
 * cookie, so a crafted callback link cannot sign out someone signed in; it
 * only says why when there is no session to fall back on.
 */
export async function restoreSession(deps: AuthDeps, query: string): Promise<SessionOutcome> {
  const callback = readSignInCallback({
    query,
    pending: deps.pending.take(),
    now: deps.clock.now(),
  });
  if (callback.kind === 'code') {
    const { code, verifier } = callback;
    return redeemGrant(deps, () => deps.gateway.exchange({ code, verifier }));
  }
  const restored = await redeemGrant(deps, () => deps.gateway.refresh());
  if ('session' in restored) return restored;
  if (callback.kind === 'failed') return { failure: callback.reason };
  return { failure: restored.failure === 'no-session' ? null : restored.failure };
}
