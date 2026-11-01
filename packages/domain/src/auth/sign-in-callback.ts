import type { AuthFailureKind } from './auth-session.ts';
import { PENDING_SIGN_IN_MS, type PendingSignIn } from './sign-in-request.ts';

/*
 * GitHub's redirect back to the web build (#663, ADR-0052), read against the
 * sign-in this tab started. The `state` is checked before anything else, so a
 * link crafted elsewhere — with a code, or with an error — is only ever a
 * mismatch: it cannot sign the person in to someone else's account, nor put
 * words of its choosing on the screen.
 */

export type SignInCallback =
  /** Not a callback: an ordinary visit. */
  | { readonly kind: 'none' }
  /** A code to redeem, with the verifier the sign-in started with. */
  | { readonly kind: 'code'; readonly code: string; readonly verifier: string }
  | { readonly kind: 'failed'; readonly reason: CallbackFailure };

export type CallbackFailure = Extract<
  AuthFailureKind,
  'denied' | 'state-mismatch' | 'stale' | 'refused' | 'malformed'
>;

/** GitHub's codes are 20 hex characters today; this allows for more without allowing anything. */
const CODE = /^[A-Za-z0-9_-]{1,256}$/;

const failed = (reason: CallbackFailure): SignInCallback => ({ kind: 'failed', reason });

/** The one value of `name`, or null when it is missing or given more than once. */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

/**
 * What the page's query says, given the pending sign-in (already taken from
 * its store, so it is used at most once) and the time now.
 */
export function readSignInCallback(args: {
  query: string;
  pending: PendingSignIn | null;
  now: number;
}): SignInCallback {
  const params = new URLSearchParams(args.query);
  if (!['code', 'error', 'state'].some((name) => params.has(name))) return { kind: 'none' };
  const { pending, now } = args;
  if (pending === null || single(params, 'state') !== pending.state)
    return failed('state-mismatch');
  if (now < pending.startedAt || now - pending.startedAt > PENDING_SIGN_IN_MS)
    return failed('stale');
  if (params.has('error'))
    return failed(single(params, 'error') === 'access_denied' ? 'denied' : 'refused');
  const code = single(params, 'code');
  if (code === null || !CODE.test(code)) return failed('malformed');
  return { kind: 'code', code, verifier: pending.verifier };
}
