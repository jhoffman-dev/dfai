import type { AuthFailureKind, PendingSignIn, TokenGrant } from '@dfai/domain';

/*
 * Sign-in with GitHub for the web build (#663, ADR-0052). The rest of the app
 * sees only {@link AuthPort}; the use-cases behind it need the ports below,
 * which the browser's adapters answer.
 */

/** A sign-in step that failed, and why. */
export class AuthError extends Error {
  readonly kind: AuthFailureKind;

  constructor(kind: AuthFailureKind, message: string = kind) {
    super(message);
    this.name = 'AuthError';
    this.kind = kind;
  }
}

/**
 * The sign-in function (a Firebase Function on the site's own origin), which
 * holds the GitHub App's client secret and the refresh token's cookie. The
 * browser never sees either; it sees access tokens.
 */
export interface AuthGateway {
  /** Leaves the page for GitHub's consent screen, by way of the function. */
  start(args: { state: string; codeChallenge: string }): void;
  /** Redeems GitHub's code; the function keeps the refresh token in its cookie. */
  exchange(args: { code: string; verifier: string }): Promise<TokenGrant>;
  /** A new access token from the cookie's refresh token, which the function rotates. */
  refresh(): Promise<TokenGrant>;
  /** Clears the cookie, and revokes `accessToken` at GitHub when one is given. */
  signOut(args: { accessToken: string | null }): Promise<void>;
}

/** Where a started sign-in waits for its callback: this tab's alone, and read once. */
export interface PendingSignInStore {
  save(pending: PendingSignIn): void;
  /** The pending sign-in, removed as it is read; null when there is none or it is unreadable. */
  take(): PendingSignIn | null;
}

/**
 * Cryptographically secure random bytes. Not the app's `Rng`, whose numbers
 * are for block ids: a guessable `state` or verifier defeats its purpose.
 */
export interface SecureRandom {
  bytes(count: number): Uint8Array;
}

/** SHA-256 of a text's UTF-8 bytes, for the PKCE challenge. */
export interface Sha256 {
  digest(text: string): Promise<Uint8Array>;
}

/** Where the web build's sign-in stands. */
export type AuthState =
  | { readonly status: 'checking' }
  | { readonly status: 'signed-in' }
  /** `reason` says why, when the person did not simply sign out or never signed in. */
  | { readonly status: 'signed-out'; readonly reason: AuthFailureKind | null };

/** The sign-in, as the rest of the web build uses it. */
export interface AuthPort {
  state(): AuthState;
  /** Called on every change of {@link state}; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /**
   * Once, as the page starts: finishes the sign-in GitHub's callback in
   * `query` answers, or restores the session from the function's cookie.
   */
  restore(query: string): Promise<AuthState>;
  /** Leaves for GitHub to sign in. */
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** An access token fit to send now, refreshed first when it is close to expiring. */
  tokenForRequest(): Promise<string>;
  /**
   * GitHub answered a request sent with `accessToken` 401: that token, and
   * the session, are no longer good. A token already replaced by a refresh
   * ends nothing, so a slow answer to an old request cannot sign anyone out.
   */
  rejected(accessToken: string): void;
}
