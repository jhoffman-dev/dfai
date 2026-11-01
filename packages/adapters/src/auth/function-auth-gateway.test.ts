import { AuthError } from '@dfai/application';
import { describe, expect, it } from 'vitest';
import { functionAuthGateway, REFRESH_LOCK, type CrossTabLock } from './function-auth-gateway.ts';

/**
 * #663, ADR-0052: the browser's side of the sign-in function, against a fake
 * of the function's answers. The round trip with the function itself is in
 * apps/auth-function/src/round-trip.test.ts.
 */

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

function gatewayAnswering(answer: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const navigated: string[] = [];
  const locked: string[] = [];
  const lock: CrossTabLock = (name, task) => {
    locked.push(name);
    return task();
  };
  const gateway = functionAuthGateway({
    fetch: async (url, init) => {
      const call = { url: String(url), init };
      sent.push(call);
      return answer(call);
    },
    navigate: (url) => navigated.push(url),
    lock,
  });
  return { gateway, sent, navigated, locked };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const grant = () => json(200, { accessToken: 'ghu_one', expiresIn: 28800 });

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AuthError);
  return (error as AuthError).kind;
};

describe('the sign-in function, from the browser', () => {
  it('starts by leaving for the function’s start, on this origin, with the state and challenge', () => {
    const { gateway, navigated, sent } = gatewayAnswering(grant);
    gateway.start({ state: 'st&te', codeChallenge: 'ch=l' });
    expect(navigated).toEqual(['/api/auth/start?state=st%26te&code_challenge=ch%3Dl']);
    expect(sent).toEqual([]);
  });

  it('redeems a code by a same-origin POST, uncached, and reads the grant', async () => {
    const { gateway, sent } = gatewayAnswering(grant);
    expect(await gateway.exchange({ code: 'c0de', verifier: 'v' })).toEqual({
      accessToken: 'ghu_one',
      expiresInSeconds: 28800,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/api/auth/token');
    expect(sent[0]?.init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({ code: 'c0de', codeVerifier: 'v' });
  });

  it('refreshes under the cross-tab lock, sending nothing but the cookie the browser adds', async () => {
    const { gateway, sent, locked } = gatewayAnswering(grant);
    await gateway.refresh();
    expect(locked).toEqual([REFRESH_LOCK]);
    expect(sent[0]?.url).toBe('/api/auth/refresh');
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({});
  });

  it('signs out with the token to revoke, and takes a 204', async () => {
    const { gateway, sent } = gatewayAnswering(() => new Response(null, { status: 204 }));
    await gateway.signOut({ accessToken: 'ghu_one' });
    expect(sent[0]?.url).toBe('/api/auth/signout');
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({ accessToken: 'ghu_one' });
  });

  it.each([
    [401, 'bad-code', 'bad-code'],
    [401, 'no-session', 'no-session'],
    [401, 'revoked', 'revoked'],
    [403, 'refused', 'refused'],
    [502, 'unavailable', 'network'],
  ])('reads a %i with %s as %s', async (status, error, kind) => {
    const { gateway } = gatewayAnswering(() => json(status, { error }));
    expect(await failure(gateway.exchange({ code: 'c', verifier: 'v' }))).toBe(kind);
  });

  it('reads an error it does not know as a refusal, or as unreachable for a 5xx', async () => {
    expect(
      await failure(gatewayAnswering(() => json(400, { error: 'toString' })).gateway.refresh()),
    ).toBe('refused');
    expect(
      await failure(
        gatewayAnswering(() => new Response('<html>', { status: 503 })).gateway.refresh(),
      ),
    ).toBe('network');
  });

  it('reads a fetch that throws (offline, blocked) as unreachable', async () => {
    const { gateway } = gatewayAnswering(() => {
      throw new TypeError('Load failed');
    });
    expect(await failure(gateway.refresh())).toBe('network');
    expect(await failure(gateway.signOut({ accessToken: null }))).toBe('network');
  });

  it.each([
    ['no token', { expiresIn: 28800 }],
    ['a token that is not text', { accessToken: 7, expiresIn: 28800 }],
    ['a lifetime that is not a number', { accessToken: 'ghu', expiresIn: '28800' }],
    ['null', null],
  ])('refuses a 200 with %s as malformed', async (_what, body) => {
    const { gateway } = gatewayAnswering(() => json(200, body));
    expect(await failure(gateway.refresh())).toBe('malformed');
  });

  it('refuses a 200 that is not JSON as malformed', async () => {
    const { gateway } = gatewayAnswering(() => new Response('<html>', { status: 200 }));
    expect(await failure(gateway.exchange({ code: 'c', verifier: 'v' }))).toBe('malformed');
  });
});
