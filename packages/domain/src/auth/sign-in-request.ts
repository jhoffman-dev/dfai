/*
 * The two secrets a sign-in starts with (#663, ADR-0052): the OAuth `state`,
 * which ties GitHub's callback to the tab that left for it (CSRF), and the
 * PKCE verifier, which ties the code to that tab too, so a code read from
 * the address bar or a log cannot be redeemed by anyone else.
 */

/** Random bytes in each secret: 256 bits, 43 characters in base64url. */
export const SIGN_IN_SECRET_BYTES = 32;

/** How long a started sign-in waits for its callback. GitHub's codes live ten minutes. */
export const PENDING_SIGN_IN_MS = 10 * 60_000;

/** A sign-in that left for GitHub and has not come back yet. */
export interface PendingSignIn {
  readonly state: string;
  readonly verifier: string;
  /** Milliseconds since the epoch. */
  readonly startedAt: number;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Bytes as unpadded base64url (RFC 4648 §5), the form PKCE's S256 challenge takes. */
export function base64url(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 3) {
    const chunk = ((bytes[at] ?? 0) << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0);
    const sextets = Math.min(4, Math.ceil(((bytes.length - at) * 8) / 6));
    for (let i = 0; i < sextets; i += 1) text += ALPHABET[(chunk >> (18 - 6 * i)) & 63];
  }
  return text;
}

/** RFC 7636's code verifier: 43 to 128 unreserved characters. The state is held to the same. */
const SECRET = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Whether `text` could be a state or a PKCE verifier this build made. */
export const isWellFormedSignInSecret = (text: string): boolean => SECRET.test(text);

/**
 * A new pending sign-in from two independent draws of secure random bytes.
 * Throws when a draw is short: a guessable state or verifier is worse than
 * no sign-in at all.
 */
export function newPendingSignIn(args: {
  stateBytes: Uint8Array;
  verifierBytes: Uint8Array;
  now: number;
}): PendingSignIn {
  const { stateBytes, verifierBytes, now } = args;
  if (stateBytes.length < SIGN_IN_SECRET_BYTES || verifierBytes.length < SIGN_IN_SECRET_BYTES)
    throw new Error(`a sign-in needs ${SIGN_IN_SECRET_BYTES} random bytes for each secret`);
  return { state: base64url(stateBytes), verifier: base64url(verifierBytes), startedAt: now };
}
