/*
 * The refresh token's cookie (#663, ADR-0052). Firebase Hosting strips every
 * cookie but `__session` from requests it rewrites to a function, so that is
 * its name. HttpOnly keeps it from the page's scripts, Secure from plain
 * http, SameSite=Strict from other sites' requests, and Path from every
 * request but the function's own.
 */

export const COOKIE = '__session';
export const COOKIE_PATH = '/api/auth';

/** A refresh token as GitHub issues one (`ghr_…`): nothing that could break out of the cookie. */
const VALUE = /^[A-Za-z0-9_.-]{1,512}$/;

const ATTRIBUTES = `Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`;

/** Sets the cookie to `refreshToken` for as long as GitHub says it lives. */
export function setRefreshCookie(refreshToken: string, maxAgeSeconds: number): string {
  if (!VALUE.test(refreshToken))
    throw new Error('a refresh token with characters a cookie cannot hold');
  return `${COOKIE}=${refreshToken}; Max-Age=${Math.floor(maxAgeSeconds)}; ${ATTRIBUTES}`;
}

export const clearRefreshCookie = (): string => `${COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;

/** The refresh token in a request's Cookie header, or null when it is absent or not one. */
export function readRefreshCookie(header: string | null): string | null {
  for (const part of (header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== COOKIE) continue;
    const value = rest.join('=');
    return VALUE.test(value) ? value : null;
  }
  return null;
}
