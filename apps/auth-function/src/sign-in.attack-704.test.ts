import { webcrypto } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  functionAuthGateway,
  sessionStoragePendingSignIn,
  webCryptoRandom,
  webCryptoSha256,
  webLocks,
  type CrossTabLock,
} from '@dfai/adapters';
import { createAuthService } from '@dfai/application';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_ID, CLIENT_SECRET, fakeGitHub, s256 } from './fake-github.test-support.ts';
import { GITHUB_TOKEN, githubOAuth, readTokenAnswer } from './github-oauth.ts';
import { authHandler } from './handler.ts';
import { nodeListener } from './node-listener.ts';

/*
 * Attack on PR #704 (issue #663, ADR-0052): the sign-in function over real
 * loopback HTTP with GitHub faked, and the web build's real sign-in driving
 * it from two tabs that share one cookie jar. Nothing leaves this machine.
 * `it.fails` marks a test that proves a bug; the rest are probes that held.
 */

const ORIGIN = 'https://dailyflowai-web.web.app';
const HOUR = 60 * 60_000;
const T0 = Date.UTC(2026, 9, 31, 9, 0, 0);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

/** GitHub's answers to token requests, held until the test lets each one go. */
function holdingGitHub() {
  const github = fakeGitHub();
  const held: { release: () => void }[] = [];
  let holding = false;
  let heldCount = deferred<void>();
  let wantHeld = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    // GitHub decides at once (a refresh token is spent on arrival); only its answer is held.
    const answer = await github.fetch(input, init);
    if (!holding || String(input) !== GITHUB_TOKEN) return answer;
    const gate = deferred<void>();
    held.push({ release: () => gate.resolve() });
    if (held.length >= wantHeld) heldCount.resolve();
    await gate.promise;
    return answer;
  };
  return {
    github,
    fetch,
    hold: () => void (holding = true),
    /** Resolves once `count` answers are being held. */
    whenHeld: (count: number) => {
      wantHeld = count;
      heldCount = deferred<void>();
      if (held.length >= count) heldCount.resolve();
      return heldCount.promise;
    },
    release: (at: number) => held[at]?.release(),
  };
}

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done()))));
  servers = [];
});

async function serve(fetch: typeof globalThis.fetch, timeoutMs = 10_000) {
  const listener = nodeListener(
    authHandler({
      config: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, origin: ORIGIN },
      github: githubOAuth({ fetch, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, timeoutMs }),
    }),
  );
  const server = createServer((req, res) => void listener(req, res));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

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

/** One browser's cookie jar, shared by its tabs, applying Set-Cookie in the order answers land. */
function browser(base: string) {
  const jar = new Map<string, string>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    headers.set('Origin', ORIGIN);
    const cookie = jar.get('__session');
    if (cookie && path.startsWith('/api/auth/')) headers.set('Cookie', `__session=${cookie}`);
    const response = await globalThis.fetch(`${base}${path}`, { ...init, headers });
    for (const set of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = set.split('; ');
      const [name = '', value = ''] = pair.split('=');
      if (attributes.includes('Max-Age=0')) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  return { jar, fetch };
}

/** Web Locks played in memory: one holder per name, the rest queued in order. */
function sharedLock() {
  const tails = new Map<string, Promise<unknown>>();
  let waiting = deferred<void>();
  let holders = 0;
  const lock: CrossTabLock = (name, task) => {
    const before = tails.get(name) ?? Promise.resolve();
    holders += 1;
    if (holders > 1) waiting.resolve();
    const run = before.then(task).finally(() => {
      holders -= 1;
    });
    tails.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  };
  return { lock, someoneWaits: () => ((waiting = deferred<void>()), waiting.promise) };
}

function tab(page: ReturnType<typeof browser>, lock: CrossTabLock, navigated: string[] = []) {
  let now = T0;
  const auth = createAuthService({
    gateway: functionAuthGateway({
      fetch: page.fetch,
      navigate: (url) => void navigated.push(url),
      lock,
    }),
    pending: sessionStoragePendingSignIn(memoryStorage()),
    random: webCryptoRandom(webcrypto as Crypto),
    sha256: webCryptoSha256(webcrypto.subtle as SubtleCrypto),
    clock: { now: () => now },
  });
  return { auth, navigated, advance: (ms: number) => (now += ms) };
}

/** Signs `t` in through the start redirect and GitHub's consent. */
async function signIn(
  base: string,
  t: ReturnType<typeof tab>,
  github: ReturnType<typeof fakeGitHub>,
) {
  await t.auth.signIn();
  const start = await globalThis.fetch(`${base}${t.navigated.at(-1)}`, { redirect: 'manual' });
  const authorize = new URL(start.headers.get('location') ?? '');
  const code = github.issueCode({
    challenge: authorize.searchParams.get('code_challenge') ?? '',
    redirectUri: authorize.searchParams.get('redirect_uri') ?? '',
  });
  await t.auth.restore(`?code=${code}&state=${authorize.searchParams.get('state')}`);
}

describe('two tabs and the rotated refresh cookie', () => {
  it.fails(
    'a sign-out in one tab is not undone by another tab’s refresh landing after it',
    async () => {
      const gh = holdingGitHub();
      const base = await serve(gh.fetch);
      const page = browser(base);
      const { lock, someoneWaits } = sharedLock();
      const a = tab(page, lock);
      const b = tab(page, lock);
      await signIn(base, a, gh.github);
      expect(await b.auth.restore('')).toEqual({ status: 'signed-in' });

      // Tab B's token is due: its refresh holds the lock while GitHub answers.
      gh.hold();
      const held = gh.whenHeld(1);
      b.advance(8 * HOUR - 4 * 60_000);
      const refreshing = b.auth.tokenForRequest();
      await held;

      // Tab A signs out meanwhile. Either it waits for the lock (right), or it goes through.
      const signingOut = a.auth.signOut();
      await Promise.race([signingOut, someoneWaits()]);
      gh.release(0);
      await Promise.all([refreshing, signingOut]);

      expect(a.auth.state()).toEqual({ status: 'signed-out', reason: null });
      // The person signed out of this browser: a reload must not sign them back in.
      expect(page.jar.has('__session')).toBe(false);
    },
  );

  it.fails(
    'without Web Locks, two tabs loading at once leave one of them a working session',
    async () => {
      const gh = holdingGitHub();
      const base = await serve(gh.fetch);
      const page = browser(base);
      const noLocks = webLocks(undefined);
      const first = tab(page, noLocks);
      await signIn(base, first, gh.github);

      // Two tabs opened together (Safari restoring them): each restores by one refresh.
      const a = tab(page, noLocks);
      const b = tab(page, noLocks);
      gh.hold();
      const held = gh.whenHeld(2);
      const restoringA = a.auth.restore('');
      const restoringB = b.auth.restore('');
      await held;
      // GitHub rotated for the first to arrive and refused the second; answers land in that order.
      gh.release(0);
      await Promise.race([restoringA, restoringB]);
      gh.release(1);
      await Promise.all([restoringA, restoringB]);

      const signedIn = [a, b].filter((t) => t.auth.state().status === 'signed-in');
      expect(signedIn).toHaveLength(1);
      // ADR-0052: "one tab may be signed out". The winner must still be able to refresh.
      expect(page.jar.has('__session')).toBe(true);
    },
  );

  it.fails(
    'without Web Locks, the tab that lost the race is not told GitHub revoked DFAI',
    async () => {
      const gh = holdingGitHub();
      const base = await serve(gh.fetch);
      const page = browser(base);
      const noLocks = webLocks(undefined);
      await signIn(base, tab(page, noLocks), gh.github);
      const a = tab(page, noLocks);
      const b = tab(page, noLocks);
      gh.hold();
      const held = gh.whenHeld(2);
      const states = Promise.all([a.auth.restore(''), b.auth.restore('')]);
      await held;
      gh.release(0);
      gh.release(1);
      const reasons = (await states).map((state) =>
        state.status === 'signed-out' ? state.reason : null,
      );
      // Nobody removed the App: "GitHub no longer lets DFAI reach your vault" is untrue.
      expect(reasons).not.toContain('revoked');
    },
  );

  it('with Web Locks, two tabs loading at once both stay signed in', async () => {
    const gh = holdingGitHub();
    const base = await serve(gh.fetch);
    const page = browser(base);
    const { lock } = sharedLock();
    await signIn(base, tab(page, lock), gh.github);
    const a = tab(page, lock);
    const b = tab(page, lock);
    const states = await Promise.all([a.auth.restore(''), b.auth.restore('')]);
    expect(states).toEqual([{ status: 'signed-in' }, { status: 'signed-in' }]);
    expect(page.jar.has('__session')).toBe(true);
  });

  it('a 401 for a token a refresh replaced does not end the new session', async () => {
    const gh = holdingGitHub();
    const base = await serve(gh.fetch);
    const page = browser(base);
    const t = tab(page, webLocks(undefined));
    await signIn(base, t, gh.github);
    const old = await t.auth.tokenForRequest();
    t.advance(8 * HOUR - 4 * 60_000);
    const fresh = await t.auth.tokenForRequest();
    expect(fresh).not.toBe(old);
    t.auth.rejected(old);
    expect(t.auth.state()).toEqual({ status: 'signed-in' });
    expect(await t.auth.tokenForRequest()).toBe(fresh);
  });

  it('sign-out during a callback exchange ends signed out with the cookie cleared', async () => {
    const gh = holdingGitHub();
    const base = await serve(gh.fetch);
    const page = browser(base);
    const t = tab(page, webLocks(undefined));
    await t.auth.signIn();
    const start = await globalThis.fetch(`${base}${t.navigated.at(-1)}`, { redirect: 'manual' });
    const authorize = new URL(start.headers.get('location') ?? '');
    const code = gh.github.issueCode({
      challenge: authorize.searchParams.get('code_challenge') ?? '',
      redirectUri: authorize.searchParams.get('redirect_uri') ?? '',
    });
    gh.hold();
    const held = gh.whenHeld(1);
    const restoring = t.auth.restore(`?code=${code}&state=${authorize.searchParams.get('state')}`);
    await held;
    const signingOut = t.auth.signOut();
    gh.release(0);
    await Promise.all([restoring, signingOut]);
    expect(t.auth.state()).toEqual({ status: 'signed-out', reason: null });
    expect(page.jar.has('__session')).toBe(false);
  });
});

/** A raw request, so headers can be duplicated or left out as no fetch would. */
function raw(
  base: string,
  args: {
    path: string;
    method?: string;
    headers?: Record<string, string | string[]>;
    body?: string;
  },
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}${args.path}`,
      { method: args.method ?? 'POST', headers: args.headers ?? {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(args.body);
  });
}

const JSON_HEADERS = { Origin: ORIGIN, 'Content-Type': 'application/json' };

describe('the function’s gate on POSTs', () => {
  it.each([
    ['none', undefined],
    ['null', 'null'],
    ['http', 'http://dailyflowai-web.web.app'],
    ['upper case', 'https://DailyFlowAI-web.web.app'],
    ['a trailing slash', `${ORIGIN}/`],
    ['an explicit port', `${ORIGIN}:443`],
    ['a suffix host', `${ORIGIN}.evil.com`],
    ['a preview channel', 'https://dailyflowai-web--pr-704-abc.web.app'],
    ['duplicated', [ORIGIN, ORIGIN]],
  ])('refuses an Origin that is %s', async (_what, origin) => {
    const base = await serve(fakeGitHub().fetch);
    const headers: Record<string, string | string[]> = { 'Content-Type': 'application/json' };
    if (origin !== undefined) headers.Origin = origin;
    for (const path of ['/api/auth/token', '/api/auth/refresh', '/api/auth/signout']) {
      const res = await raw(base, { path, headers, body: '{"accessToken":null}' });
      expect(res.status).toBe(403);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it.each([
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'text/plain',
    'text/plain; charset=application/json',
  ])('refuses a %s body, which a cross-site form could send', async (type) => {
    const base = await serve(fakeGitHub().fetch);
    const res = await raw(base, {
      path: '/api/auth/signout',
      headers: { Origin: ORIGIN, 'Content-Type': type },
      body: 'accessToken=x',
    });
    expect(res.status).toBe(415);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a body past 4 KB, streamed or not, without reading it all', async () => {
    const base = await serve(fakeGitHub().fetch);
    const big = JSON.stringify({ accessToken: null, pad: 'x'.repeat(1_000_000) });
    const res = await raw(base, { path: '/api/auth/signout', headers: JSON_HEADERS, body: big });
    expect(res.status).toBe(413);
  });

  it.each(['{', 'null', '[]', '"x"', '{"code":1}', '\u0000'])(
    'refuses %j as a token request without calling GitHub',
    async (body) => {
      const gh = fakeGitHub();
      const base = await serve(gh.fetch);
      const res = await raw(base, { path: '/api/auth/token', headers: JSON_HEADERS, body });
      expect(res.status).toBe(400);
      expect(gh.requests).toEqual([]);
    },
  );

  it('refuses a GET, HEAD or PUT on a POST route', async () => {
    const base = await serve(fakeGitHub().fetch);
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await raw(base, { path: '/api/auth/refresh', method, headers: JSON_HEADERS });
      expect(res.status).toBe(405);
    }
  });
});

describe('what leaves the function', () => {
  it('sends the browser only to GitHub, whatever the start query carries', async () => {
    const base = await serve(fakeGitHub().fetch);
    const ok = 's'.repeat(43);
    for (const query of [
      `state=${ok}&code_challenge=${ok}&redirect_uri=https://evil.example`,
      `state=${ok}&code_challenge=${ok}&state=//evil.example`,
      `state=${ok}%0d%0aLocation:%20https://evil.example&code_challenge=${ok}`,
      `state=//evil.example${'a'.repeat(40)}&code_challenge=${ok}`,
    ]) {
      const res = await raw(base, { path: `/api/auth/start?${query}`, method: 'GET' });
      if (res.status === 302) {
        const location = new URL(String(res.headers.location));
        expect(location.origin + location.pathname).toBe(
          'https://github.com/login/oauth/authorize',
        );
        expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
      } else expect(res.status).toBe(400);
    }
  });

  it('never answers with the client secret, the code or the refresh token, on any path', async () => {
    const gh = fakeGitHub();
    const base = await serve(gh.fetch);
    const verifier = 'v'.repeat(43);
    const code = gh.issueCode({
      challenge: s256(verifier),
      redirectUri: `${ORIGIN}/auth/callback`,
    });
    const answers = [
      await raw(base, {
        path: '/api/auth/token',
        headers: JSON_HEADERS,
        body: JSON.stringify({ code, codeVerifier: verifier }),
      }),
    ];
    const refresh = /__session=([^;]+)/.exec(String(answers[0]?.headers['set-cookie']))?.[1] ?? '';
    expect(refresh).toMatch(/^ghr_/);
    answers.push(
      await raw(base, {
        path: '/api/auth/token',
        headers: JSON_HEADERS,
        body: JSON.stringify({ code, codeVerifier: verifier }),
      }),
      await raw(base, {
        path: '/api/auth/refresh',
        headers: { ...JSON_HEADERS, Cookie: `__session=${refresh}` },
        body: '{}',
      }),
      await raw(base, {
        path: '/api/auth/refresh',
        headers: { ...JSON_HEADERS, Cookie: `__session=${refresh}` },
        body: '{}',
      }),
    );
    gh.override = () => new Response(`<html>${CLIENT_SECRET} ${refresh}</html>`, { status: 500 });
    answers.push(
      await raw(base, {
        path: '/api/auth/refresh',
        headers: { ...JSON_HEADERS, Cookie: `__session=${refresh}` },
        body: '{}',
      }),
    );
    expect(answers.map((a) => a.status)).toEqual([200, 401, 200, 401, 502]);
    for (const answer of answers) {
      for (const secret of [CLIENT_SECRET, code, refresh])
        expect(answer.body).not.toContain(secret);
      expect(answer.headers['cache-control']).toBe('no-store');
      for (const cookie of [answer.headers['set-cookie'] ?? []].flat())
        expect(cookie).toMatch(/; Path=\/api\/auth; HttpOnly; Secure; SameSite=Strict$/);
    }
  });

  it('a revoked refresh clears the cookie with the same attributes it was set with', async () => {
    const base = await serve(fakeGitHub().fetch);
    const res = await raw(base, {
      path: '/api/auth/refresh',
      headers: { ...JSON_HEADERS, Cookie: '__session=ghr_unknown' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toEqual([
      '__session=; Max-Age=0; Path=/api/auth; HttpOnly; Secure; SameSite=Strict',
    ]);
  });

  it('does not put a refresh token with cookie syntax in its Set-Cookie', async () => {
    const gh = fakeGitHub();
    const base = await serve(gh.fetch);
    gh.override = () =>
      Response.json({
        access_token: 'ghu_ok',
        expires_in: 28800,
        refresh_token: 'ghr_x; Domain=evil.example',
        refresh_token_expires_in: 100,
      });
    const res = await raw(base, {
      path: '/api/auth/refresh',
      headers: { ...JSON_HEADERS, Cookie: '__session=ghr_a' },
      body: '{}',
    });
    expect(res.status).toBe(500);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('GitHub misbehaving behind the function', () => {
  async function slowGitHub(dripBody: boolean) {
    const server = createServer((_req, res) => {
      if (!dripBody) return; // never answers
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"access_token":');
      // and never finishes the body
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const fetch: typeof globalThis.fetch = (input, init) =>
      globalThis.fetch(String(input).replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${port}`), init);
    return fetch;
  }

  it.each([
    ['never answers', false],
    ['answers its headers and never its body', true],
  ])('gives up on a GitHub that %s, keeping the cookie', async (_what, drip) => {
    const base = await serve(await slowGitHub(drip), 100);
    const res = await raw(base, {
      path: '/api/auth/refresh',
      headers: { ...JSON_HEADERS, Cookie: '__session=ghr_a' },
      body: '{}',
    });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: 'unavailable' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it.fails(
    'an error name GitHub sends is never taken for one of its own failures (`__proto__`)',
    () => {
      const failures = ['bad-code', 'revoked', 'misconfigured', 'upstream'];
      for (const error of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        const result = readTokenAnswer({ error });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(failures).toContain(result.failure);
      }
    },
  );
});
