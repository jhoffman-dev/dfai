import { describe, expect, it } from 'vitest';
import { CLIENT_ID, CLIENT_SECRET, fakeGitHub, s256 } from './fake-github.test-support.ts';
import { githubOAuth } from './github-oauth.ts';
import { authHandler, MAX_BODY_BYTES } from './handler.ts';

/** #663, ADR-0052: the sign-in function's routes, against a fake GitHub token endpoint. */

const ORIGIN = 'https://dailyflowai-web.web.app';
const REDIRECT = `${ORIGIN}/auth/callback`;
const STATE = 's'.repeat(43);
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = s256(VERIFIER);

function setUp() {
  const github = fakeGitHub();
  const handle = authHandler({
    config: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, origin: ORIGIN },
    github: githubOAuth({ fetch: github.fetch, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    handle(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  const code = () => github.issueCode({ challenge: CHALLENGE, redirectUri: REDIRECT });
  return { github, handle, post, code };
}

const cookieOf = (response: Response) => response.headers.getSetCookie()[0] ?? '';
const refreshTokenOf = (response: Response) => /__session=([^;]*)/.exec(cookieOf(response))?.[1];
const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error;

describe('starting a sign-in', () => {
  it('sends the browser to GitHub with the App, its callback, the state and an S256 challenge', async () => {
    const { handle } = setUp();
    const response = await handle(
      new Request(`${ORIGIN}/api/auth/start?state=${STATE}&code_challenge=${CHALLENGE}`),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      state: STATE,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    ['no state', `code_challenge=${CHALLENGE}`],
    ['a short state', `state=abc&code_challenge=${CHALLENGE}`],
    ['no challenge', `state=${STATE}`],
    ['a challenge with odd characters', `state=${STATE}&code_challenge=${'%2B'.repeat(43)}`],
  ])('refuses %s', async (_what, query) => {
    const { handle } = setUp();
    const response = await handle(new Request(`${ORIGIN}/api/auth/start?${query}`));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('refused');
  });
});

describe('redeeming a code', () => {
  it('hands the browser the access token alone, and the refresh token in an httpOnly cookie', async () => {
    const { post, code } = setUp();
    const response = await post('/api/auth/token', { code: code(), codeVerifier: VERIFIER });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ accessToken: expect.stringMatching(/^ghu_/), expiresIn: 28800 });
    expect(JSON.stringify(body)).not.toMatch(/ghr_/);
    expect(cookieOf(response)).toMatch(
      /^__session=ghr_\w+; Max-Age=15897600; Path=\/api\/auth; HttpOnly; Secure; SameSite=Strict$/,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('is a bad code with the wrong verifier, or a second time', async () => {
    const { post, code } = setUp();
    const once = code();
    const wrong = await post('/api/auth/token', { code: once, codeVerifier: 'w'.repeat(43) });
    expect([wrong.status, await errorOf(wrong)]).toEqual([401, 'bad-code']);
    const twice = code();
    await post('/api/auth/token', { code: twice, codeVerifier: VERIFIER });
    const again = await post('/api/auth/token', { code: twice, codeVerifier: VERIFIER });
    expect([again.status, await errorOf(again)]).toEqual([401, 'bad-code']);
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it.each([
    ['no code', { codeVerifier: VERIFIER }],
    ['a code that is not text', { code: 7, codeVerifier: VERIFIER }],
    ['a short verifier', { code: 'abc', codeVerifier: 'v' }],
    ['a verifier that is not text', { code: 'abc', codeVerifier: ['v'] }],
  ])('refuses %s without asking GitHub', async (_what, body) => {
    const { post, github } = setUp();
    const response = await post('/api/auth/token', body);
    expect([response.status, await errorOf(response)]).toEqual([400, 'refused']);
    expect(github.requests).toEqual([]);
  });

  it('is unavailable, setting no cookie, when GitHub is down or the App is misconfigured', async () => {
    const { post, code, github } = setUp();
    github.override = () => new Response('busy', { status: 503 });
    const down = await post('/api/auth/token', { code: code(), codeVerifier: VERIFIER });
    expect([down.status, await errorOf(down)]).toEqual([502, 'unavailable']);
    github.override = null;
    github.expiryOff = true;
    const off = await post('/api/auth/token', { code: code(), codeVerifier: VERIFIER });
    expect([off.status, await errorOf(off)]).toEqual([500, 'unavailable']);
    expect(off.headers.getSetCookie()).toEqual([]);
  });
});

describe('refreshing', () => {
  async function signedIn() {
    const world = setUp();
    const response = await world.post('/api/auth/token', {
      code: world.code(),
      codeVerifier: VERIFIER,
    });
    return { ...world, refreshToken: refreshTokenOf(response) ?? '' };
  }

  it('grants a new access token from the cookie and rotates the cookie', async () => {
    const { post, refreshToken } = await signedIn();
    const response = await post(
      '/api/auth/refresh',
      {},
      { Cookie: `x=1; __session=${refreshToken}` },
    );
    expect(response.status).toBe(200);
    const rotated = refreshTokenOf(response);
    expect(rotated).toMatch(/^ghr_/);
    expect(rotated).not.toBe(refreshToken);
  });

  it('is revoked, clearing the cookie, for a spent refresh token or a removed App', async () => {
    const { post, refreshToken, github } = await signedIn();
    const cookie = { Cookie: `__session=${refreshToken}` };
    await post('/api/auth/refresh', {}, cookie);
    const spent = await post('/api/auth/refresh', {}, cookie);
    expect([spent.status, await errorOf(spent)]).toEqual([401, 'revoked']);
    expect(cookieOf(spent)).toMatch(/^__session=; Max-Age=0; Path=\/api\/auth; HttpOnly/);
    github.revokeAll();
    const removed = await post('/api/auth/refresh', {}, cookie);
    expect(await errorOf(removed)).toBe('revoked');
  });

  it.each([
    ['no cookie', {}],
    ['another cookie', { Cookie: 'theme=dark' }],
    ['a cookie with odd characters', { Cookie: '__session=ghr_a"b' }],
  ])('is no session with %s, without asking GitHub', async (_what, headers) => {
    const { post, github } = setUp();
    const response = await post('/api/auth/refresh', {}, headers);
    expect([response.status, await errorOf(response)]).toEqual([401, 'no-session']);
    expect(github.requests).toEqual([]);
  });

  it('keeps the cookie when GitHub is down, so the browser can try again', async () => {
    const { post, refreshToken, github } = await signedIn();
    github.override = () => {
      throw new TypeError('fetch failed');
    };
    const response = await post('/api/auth/refresh', {}, { Cookie: `__session=${refreshToken}` });
    expect([response.status, await errorOf(response)]).toEqual([502, 'unavailable']);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('signing out', () => {
  it('revokes the access token at GitHub and clears the cookie', async () => {
    const { post, github } = setUp();
    const response = await post('/api/auth/signout', { accessToken: 'ghu_bye' });
    expect(response.status).toBe(204);
    expect(cookieOf(response)).toMatch(/^__session=; Max-Age=0/);
    expect(github.revoked).toEqual(new Set(['ghu_bye']));
  });

  it('clears the cookie with no token to revoke, and when GitHub cannot be reached', async () => {
    const { post, github } = setUp();
    expect((await post('/api/auth/signout', { accessToken: null })).status).toBe(204);
    expect(github.requests).toEqual([]);
    const offline = authHandler({
      config: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, origin: ORIGIN },
      github: githubOAuth({
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      }),
    });
    const response = await offline(
      new Request(`${ORIGIN}/api/auth/signout`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: 'ghu_bye' }),
      }),
    );
    expect(response.status).toBe(204);
    expect(cookieOf(response)).toMatch(/Max-Age=0/);
  });

  it('refuses a token that is not one', async () => {
    const { post, github } = setUp();
    const response = await post('/api/auth/signout', { accessToken: 'a b' });
    expect(response.status).toBe(400);
    expect(github.requests).toEqual([]);
  });
});

describe('every POST', () => {
  it.each([
    ['from another origin', { Origin: 'https://evil.example.com' }],
    ['from the default site', { Origin: 'https://dailyflowai-app.web.app' }],
    ['with no origin', { Origin: '' }],
  ])('is refused %s, without asking GitHub (CSRF)', async (_what, headers) => {
    const { post, github, code } = setUp();
    for (const path of ['/api/auth/token', '/api/auth/refresh', '/api/auth/signout']) {
      const response = await post(path, { code: code(), codeVerifier: VERIFIER }, headers);
      expect([path, response.status, await errorOf(response)]).toEqual([path, 403, 'refused']);
    }
    expect(github.requests).toEqual([]);
  });

  it('is refused as a form, which a cross-site page could send without a preflight', async () => {
    const { post } = setUp();
    const response = await post('/api/auth/refresh', 'a=1', {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(response.status).toBe(415);
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['null', 'null'],
    ['too long', JSON.stringify({ code: 'a'.repeat(MAX_BODY_BYTES) })],
  ])('is refused with a body that is %s', async (_what, body) => {
    const { post } = setUp();
    const response = await post('/api/auth/token', body);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await errorOf(response)).toBe('refused');
  });
});

describe('the routes', () => {
  it('answer nothing else, and each only to its method', async () => {
    const { handle } = setUp();
    const at = (path: string, method = 'GET') =>
      handle(new Request(`${ORIGIN}${path}`, { method })).then((response) => response.status);
    expect(await at('/api/auth/nothing')).toBe(404);
    expect(await at('/api/auth/toString')).toBe(404);
    expect(await at('/api/notes')).toBe(404);
    expect(await at('/api/auth/token')).toBe(405);
    expect(await at('/api/auth/start', 'POST')).toBe(405);
  });
});
