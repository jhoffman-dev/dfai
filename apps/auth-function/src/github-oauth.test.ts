import { describe, expect, it } from 'vitest';
import { CLIENT_ID, CLIENT_SECRET, fakeGitHub, s256 } from './fake-github.test-support.ts';
import {
  GITHUB_TOKEN,
  githubOAuth,
  githubRevoke,
  MAX_ANSWER_BYTES,
  readTokenAnswer,
} from './github-oauth.ts';

/** #663, ADR-0052: the function's calls to GitHub, against a fake of its token endpoint. */

const REDIRECT = 'https://dailyflowai-web.web.app/auth/callback';
const VERIFIER = 'v'.repeat(43);

function setUp() {
  const github = fakeGitHub();
  const oauth = githubOAuth({
    fetch: github.fetch,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  const code = github.issueCode({ challenge: s256(VERIFIER), redirectUri: REDIRECT });
  return { github, oauth, code };
}

describe('redeeming a code at GitHub', () => {
  it('sends the code, verifier, redirect and the App’s credentials, and reads the grant', async () => {
    const { github, oauth, code } = setUp();
    const result = await oauth.exchange({ code, codeVerifier: VERIFIER, redirectUri: REDIRECT });
    expect(result).toEqual({
      ok: true,
      grant: {
        accessToken: expect.stringMatching(/^ghu_/),
        expiresIn: 28800,
        refreshToken: expect.stringMatching(/^ghr_/),
        refreshExpiresIn: 15897600,
      },
    });
    expect(github.requests[0]).toMatchObject({
      url: GITHUB_TOKEN,
      method: 'POST',
      fields: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        code_verifier: VERIFIER,
        redirect_uri: REDIRECT,
      },
    });
  });

  it('is a bad code the second time, and with another verifier', async () => {
    const { github, oauth, code } = setUp();
    await oauth.exchange({ code, codeVerifier: VERIFIER, redirectUri: REDIRECT });
    expect(await oauth.exchange({ code, codeVerifier: VERIFIER, redirectUri: REDIRECT })).toEqual({
      ok: false,
      failure: 'bad-code',
    });
    const other = github.issueCode({ challenge: s256(VERIFIER), redirectUri: REDIRECT });
    expect(
      await oauth.exchange({ code: other, codeVerifier: 'w'.repeat(43), redirectUri: REDIRECT }),
    ).toEqual({ ok: false, failure: 'bad-code' });
  });

  it('is misconfigured with the wrong secret or callback', async () => {
    const { github, code } = setUp();
    const wrong = githubOAuth({ fetch: github.fetch, clientId: CLIENT_ID, clientSecret: 'nope' });
    expect(await wrong.exchange({ code, codeVerifier: VERIFIER, redirectUri: REDIRECT })).toEqual({
      ok: false,
      failure: 'misconfigured',
    });
    const { oauth, code: second } = setUp();
    expect(
      await oauth.exchange({
        code: second,
        codeVerifier: VERIFIER,
        redirectUri: 'https://x.test/cb',
      }),
    ).toEqual({ ok: false, failure: 'misconfigured' });
  });

  it('is misconfigured when the App’s token expiry is off: no token that never expires', async () => {
    const { github, oauth, code } = setUp();
    github.expiryOff = true;
    expect(await oauth.exchange({ code, codeVerifier: VERIFIER, redirectUri: REDIRECT })).toEqual({
      ok: false,
      failure: 'misconfigured',
    });
  });
});

describe('refreshing at GitHub', () => {
  it('spends the refresh token and hands back its replacement', async () => {
    const { oauth, code } = setUp();
    const first = await oauth.exchange({ code, codeVerifier: VERIFIER, redirectUri: REDIRECT });
    if (!first.ok) throw new Error('no grant');
    const second = await oauth.refresh(first.grant.refreshToken);
    expect(second.ok && second.grant.refreshToken).not.toBe(first.grant.refreshToken);
    expect(await oauth.refresh(first.grant.refreshToken)).toEqual({
      ok: false,
      failure: 'revoked',
    });
  });

  it('is revoked once the person removed the App', async () => {
    const { github, oauth, code } = setUp();
    const first = await oauth.exchange({ code, codeVerifier: VERIFIER, redirectUri: REDIRECT });
    github.revokeAll();
    expect(await oauth.refresh(first.ok ? first.grant.refreshToken : '')).toEqual({
      ok: false,
      failure: 'revoked',
    });
  });
});

describe('when GitHub is unwell', () => {
  it.each([
    ['answers a 503', () => new Response('busy', { status: 503 })],
    ['answers a 200 that is not JSON', () => new Response('<html>', { status: 200 })],
    ['answers an error it has not documented', () => Response.json({ error: 'slow_down' })],
    ['answers a token with odd characters', () => Response.json({ access_token: 'a b' })],
    [
      'cannot be reached',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
    [
      'times out',
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    ],
  ])('is upstream when it %s', async (_what, override) => {
    const { github, oauth } = setUp();
    github.override = override;
    expect(await oauth.refresh('ghr_x')).toEqual({ ok: false, failure: 'upstream' });
  });

  it('reads no more of an answer than a grant could be', async () => {
    const { github, oauth } = setUp();
    let pulled = 0;
    github.override = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled += 1;
            // Finite, so a missing cap fails on the count rather than hanging.
            if (pulled > 64) controller.close();
            else controller.enqueue(new TextEncoder().encode(' '.repeat(4096)));
          },
        }),
        { status: 200 },
      );
    expect(await oauth.refresh('ghr_x')).toEqual({ ok: false, failure: 'upstream' });
    expect(pulled).toBeLessThanOrEqual(Math.ceil(MAX_ANSWER_BYTES / 4096) + 2);
  });

  it('reads an answer up to the cap', async () => {
    const { github, oauth } = setUp();
    const body = JSON.stringify({ error: 'bad_refresh_token' });
    github.override = () => new Response(body.padEnd(MAX_ANSWER_BYTES, ' '), { status: 200 });
    expect(await oauth.refresh('ghr_x')).toEqual({ ok: false, failure: 'revoked' });
  });

  it('gives up on a slow answer after its timeout', async () => {
    const { oauth } = {
      oauth: githubOAuth({
        fetch: (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
          ),
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        timeoutMs: 5,
      }),
    };
    expect(await oauth.refresh('ghr_x')).toEqual({ ok: false, failure: 'upstream' });
  });
});

describe('revoking a token at GitHub', () => {
  it('sends it with the App’s Basic credentials, and says GitHub confirmed', async () => {
    const { github, oauth } = setUp();
    expect(await oauth.revoke('ghu_gone')).toBe(true);
    expect(github.revoked).toEqual(new Set(['ghu_gone']));
    expect(github.requests[0]).toMatchObject({ url: githubRevoke(CLIENT_ID), method: 'DELETE' });
  });

  it('says not when GitHub refuses or cannot be reached', async () => {
    const { github } = setUp();
    const wrong = githubOAuth({ fetch: github.fetch, clientId: CLIENT_ID, clientSecret: 'nope' });
    expect(await wrong.revoke('ghu_gone')).toBe(false);
    const offline = githubOAuth({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    expect(await offline.revoke('ghu_gone')).toBe(false);
  });
});

describe('a token answer', () => {
  it('is refused without positive whole lifetimes', () => {
    const base = { access_token: 'ghu_a', refresh_token: 'ghr_a', refresh_token_expires_in: 9 };
    for (const expires_in of [0, -1, 1.5, '28800', null])
      expect(readTokenAnswer({ ...base, expires_in })).toEqual({
        ok: false,
        failure: 'misconfigured',
      });
    expect(readTokenAnswer(null)).toEqual({ ok: false, failure: 'upstream' });
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
    'reads an error named %s as upstream, never as an inherited name',
    (error) => {
      expect(readTokenAnswer({ error })).toEqual({ ok: false, failure: 'upstream' });
    },
  );

  it('is refused without a refresh token a cookie can hold, whatever the lifetimes say', () => {
    const lifetimes = { access_token: 'ghu_a', expires_in: 28800, refresh_token_expires_in: 9 };
    for (const refresh_token of [undefined, 7, '', 'ghr_a; Path=/', 'ghr a'])
      expect(readTokenAnswer({ ...lifetimes, refresh_token })).toEqual({
        ok: false,
        failure: 'misconfigured',
      });
    expect(readTokenAnswer({ ...lifetimes, refresh_token: 'ghr_a' }).ok).toBe(true);
  });
});
