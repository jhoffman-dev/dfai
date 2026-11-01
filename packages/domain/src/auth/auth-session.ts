/*
 * The web build's sign-in session (#663, ADR-0052): a GitHub user-to-server
 * access token held in memory, and the rules for when it is used as it is,
 * refreshed first, or no longer usable. Pure: the time is always handed in.
 */

/** Why a sign-in failed or a session ended, which the screen picks its words by. */
export type AuthFailureKind =
  /** The person said no on GitHub's consent screen. */
  | 'denied'
  /** A callback this tab did not start, or one whose `state` does not match. */
  | 'state-mismatch'
  /** A callback for a sign-in started too long ago. */
  | 'stale'
  /** GitHub refused the code: used already, expired, or not issued to this App. */
  | 'bad-code'
  /** The refresh token no longer works: the App was uninstalled, its access revoked, or it expired. */
  | 'revoked'
  /** There is no session to restore: never signed in here, or signed out. */
  | 'no-session'
  /** The sign-in function, or GitHub behind it, could not be reached. */
  | 'network'
  /** The function refused the request as malformed or from another origin. */
  | 'refused'
  /** The function answered with something that is not a token grant. */
  | 'malformed';

/** What the sign-in function hands the browser: an access token and how long it lives. */
export interface TokenGrant {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

/** A signed-in session: the access token and the moment it stops working. */
export interface AuthSession {
  readonly accessToken: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

/**
 * How long before it expires a token is refreshed rather than used. Wide
 * enough that a request sent with it does not reach GitHub after it expired.
 */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * The longest an access token may claim to live. GitHub's user-to-server
 * tokens live 8 hours; a grant claiming longer is refused, so a token that
 * never expires (the App's expiry switched off) cannot become a session.
 */
export const LONGEST_ACCESS_MS = 24 * 60 * 60_000;

/** A token GitHub could have issued: printable, no spaces, not absurdly long. */
const TOKEN = /^[A-Za-z0-9_.-]{1,512}$/;

/**
 * The session a grant makes at `now`, or null when the grant is not one to
 * trust: an empty or odd token, or a lifetime that is not a whole number of
 * seconds longer than the refresh margin and no longer than a day.
 */
export function sessionFromGrant(grant: TokenGrant, now: number): AuthSession | null {
  const lifetime = grant.expiresInSeconds * 1000;
  if (!TOKEN.test(grant.accessToken)) return null;
  if (!Number.isInteger(grant.expiresInSeconds)) return null;
  if (lifetime <= REFRESH_MARGIN_MS || lifetime > LONGEST_ACCESS_MS) return null;
  return { accessToken: grant.accessToken, expiresAt: now + lifetime };
}

/**
 * Whether the session's token may be sent as it is (`fresh`), should be
 * refreshed first but still works if that fails (`refresh-due`), or must
 * not be sent at all (`expired`).
 */
export type SessionFreshness = 'fresh' | 'refresh-due' | 'expired';

export function sessionFreshness(session: AuthSession, now: number): SessionFreshness {
  if (now >= session.expiresAt) return 'expired';
  if (now >= session.expiresAt - REFRESH_MARGIN_MS) return 'refresh-due';
  return 'fresh';
}
