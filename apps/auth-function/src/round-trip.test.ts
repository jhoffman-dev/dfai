import { webcrypto } from 'node:crypto';
import {
  functionAuthGateway,
  sessionStoragePendingSignIn,
  webCryptoRandom,
  webCryptoSha256,
  webLocks,
} from '@dfai/adapters';
import { createAuthService } from '@dfai/application';
import { afterEach, describe, expect, it } from 'vitest';
import { ORIGIN, serveFunction, type ServedFunction } from './serve.test-support.ts';

/**
 * #663, ADR-0052, end to end but for the two hosts: the web build's real
 * sign-in (service, browser adapters, Web Crypto) against the real function
 * over HTTP, with GitHub faked and the browser's cookie rules played by a
 * small jar. The jar keeps what an httpOnly cookie is: something the page's
 * code never reads, sent only to the function's path.
 */

const HOUR = 60 * 60_000;

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    length: 0,
    clear: () => items.clear(),
    key: () => null,
    getItem: (key) => items.get(key) ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

/** The browser: same-origin fetches carry Origin, and the cookie jar applies Path and Max-Age. */
function browserFor(served: ServedFunction) {
  const jar = new Map<string, string>();
  const navigated: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    headers.set('Origin', ORIGIN);
    const cookie = jar.get('__session');
    if (cookie && path.startsWith('/api/auth/')) headers.set('Cookie', `__session=${cookie}`);
    const response = await globalThis.fetch(`${served.base}${path}`, { ...init, headers });
    for (const set of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = set.split('; ');
      const [name = '', value = ''] = pair.split('=');
      if (attributes.includes('Max-Age=0')) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  return { fetch, jar, navigated, navigate: (url: string) => void navigated.push(url) };
}

let served: ServedFunction | undefined;
afterEach(async () => {
  await served?.close();
  served = undefined;
});

async function setUp() {
  served = await serveFunction();
  const browser = browserFor(served);
  let now = Date.UTC(2026, 9, 31, 9, 0, 0);
  const auth = createAuthService({
    gateway: functionAuthGateway({
      fetch: browser.fetch,
      navigate: browser.navigate,
      lock: webLocks(undefined),
    }),
    pending: sessionStoragePendingSignIn(memoryStorage()),
    random: webCryptoRandom(webcrypto as Crypto),
    sha256: webCryptoSha256(webcrypto.subtle as SubtleCrypto),
    clock: { now: () => now },
  });
  const github = served.github;
  /** Plays the start redirect and GitHub's consent, and returns the callback's query. */
  const consent = async () => {
    const start = await globalThis.fetch(`${served?.base}${browser.navigated.at(-1)}`, {
      redirect: 'manual',
    });
    const authorize = new URL(start.headers.get('location') ?? '');
    const code = github.issueCode({
      challenge: authorize.searchParams.get('code_challenge') ?? '',
      redirectUri: authorize.searchParams.get('redirect_uri') ?? '',
    });
    return `?code=${code}&state=${authorize.searchParams.get('state')}`;
  };
  return { auth, browser, github, consent, advance: (ms: number) => (now += ms) };
}

describe('signing in with GitHub, through the function', () => {
  it('signs in, refreshes before expiry, survives a reload, and signs out', async () => {
    const { auth, browser, github, consent, advance } = await setUp();
    await auth.signIn();
    expect(browser.navigated[0]).toMatch(/^\/api\/auth\/start\?state=[\w-]{43}&code_challenge=/);
    expect(await auth.restore(await consent())).toEqual({ status: 'signed-in' });
    const first = await auth.tokenForRequest();
    expect(first).toMatch(/^ghu_/);
    const firstCookie = browser.jar.get('__session');
    expect(firstCookie).toMatch(/^ghr_/);

    advance(8 * HOUR - 4 * 60_000);
    const second = await auth.tokenForRequest();
    expect(second).not.toBe(first);
    expect(browser.jar.get('__session')).not.toBe(firstCookie);

    await auth.signOut();
    expect(browser.jar.has('__session')).toBe(false);
    expect(github.revoked).toEqual(new Set([second]));
    expect(auth.state()).toEqual({ status: 'signed-out', reason: null });
  });

  it('restores a session from the cookie on a page load', async () => {
    const { auth, consent } = await setUp();
    await auth.signIn();
    await auth.restore(await consent());
    // A reload: the page's memory is gone; the cookie is not.
    expect(await auth.restore('')).toEqual({ status: 'signed-in' });
  });

  it('signs out with a clear reason when the App is removed on GitHub', async () => {
    const { auth, github, consent, advance, browser } = await setUp();
    await auth.signIn();
    await auth.restore(await consent());
    github.revokeAll();
    advance(8 * HOUR);
    await expect(auth.tokenForRequest()).rejects.toMatchObject({ kind: 'revoked' });
    expect(auth.state()).toEqual({ status: 'signed-out', reason: 'revoked' });
    expect(browser.jar.has('__session')).toBe(false);
  });

  it('is denied when the person says no, and redeems nothing', async () => {
    const { auth, browser, github } = await setUp();
    await auth.signIn();
    const state = new URLSearchParams(browser.navigated[0]?.split('?')[1]).get('state');
    expect(await auth.restore(`?error=access_denied&state=${state}`)).toEqual({
      status: 'signed-out',
      reason: 'denied',
    });
    expect(github.requests.filter((request) => request.fields.code)).toEqual([]);
  });

  it('refuses a callback whose state another tab or site chose', async () => {
    const { auth, consent } = await setUp();
    await auth.signIn();
    const query = (await consent()).replace(/state=[\w-]+/, `state=${'x'.repeat(43)}`);
    expect(await auth.restore(query)).toEqual({ status: 'signed-out', reason: 'state-mismatch' });
  });

  it('is a bad code when a code is replayed after its sign-in finished', async () => {
    const { auth, consent } = await setUp();
    await auth.signIn();
    const callback = await consent();
    await auth.restore(callback);
    await auth.signOut();
    // The same tab signs in again and is handed the old code with the new state.
    await auth.signIn();
    const fresh = new URLSearchParams((await consent()).slice(1));
    const replay = `?code=${new URLSearchParams(callback.slice(1)).get('code')}&state=${fresh.get('state')}`;
    expect(await auth.restore(replay)).toEqual({ status: 'signed-out', reason: 'bad-code' });
  });
});
