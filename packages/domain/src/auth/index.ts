/*
 * The web build's sign-in with GitHub (#663, ADR-0052): the session's expiry
 * rules, the secrets a sign-in starts with, and how GitHub's callback is read.
 */
export {
  LONGEST_ACCESS_MS,
  REFRESH_MARGIN_MS,
  sessionFreshness,
  sessionFromGrant,
} from './auth-session.ts';
export type { AuthFailureKind, AuthSession, SessionFreshness, TokenGrant } from './auth-session.ts';
export {
  base64url,
  isWellFormedSignInSecret,
  newPendingSignIn,
  PENDING_SIGN_IN_MS,
  SIGN_IN_SECRET_BYTES,
} from './sign-in-request.ts';
export type { PendingSignIn } from './sign-in-request.ts';
export { readSignInCallback } from './sign-in-callback.ts';
export type { CallbackFailure, SignInCallback } from './sign-in-callback.ts';
