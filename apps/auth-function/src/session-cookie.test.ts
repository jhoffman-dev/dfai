import { describe, expect, it } from 'vitest';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './session-cookie.ts';

/** #663, ADR-0052: the refresh token's cookie, the one Firebase Hosting passes on. */

describe('the refresh cookie', () => {
  it('is __session, httpOnly, secure, strict, on the function’s path, for the token’s life', () => {
    expect(setRefreshCookie('ghr_abc', 15897600.9)).toBe(
      '__session=ghr_abc; Max-Age=15897600; Path=/api/auth; HttpOnly; Secure; SameSite=Strict',
    );
    expect(clearRefreshCookie()).toBe(
      '__session=; Max-Age=0; Path=/api/auth; HttpOnly; Secure; SameSite=Strict',
    );
  });

  it('refuses a token that could break out of the cookie', () => {
    for (const token of ['', 'a;b', 'a b', 'a\r\nSet-Cookie: x=1', 'a=b'])
      expect(() => setRefreshCookie(token, 1)).toThrow(/cannot hold/);
  });

  it('is read from among other cookies, and only when it is a token', () => {
    expect(readRefreshCookie('theme=dark; __session=ghr_abc; x=1')).toBe('ghr_abc');
    expect(readRefreshCookie('__session=ghr_a=b')).toBeNull();
    expect(readRefreshCookie('__session_old=ghr_abc')).toBeNull();
    expect(readRefreshCookie('__session=')).toBeNull();
    expect(readRefreshCookie(null)).toBeNull();
  });
});
