import { REFRESH_MARGIN_MS } from '@dfai/domain';
import { describe, expect, it } from 'vitest';
import {
  countingRandom,
  fakeAuthGateway,
  fakeSha256,
  memoryAuthChannel,
  memoryPendingSignIn,
} from '../testing/fake-auth.ts';
import type { AuthBroadcast } from './ports.ts';
import { createAuthService } from './auth-service.ts';
import { AuthError } from './ports.ts';

/** #663, ADR-0052: the web build's sign-in over a fake of its function. */

const START = Date.UTC(2026, 9, 31, 9, 0, 0);
const HOUR = 60 * 60_000;

function world(broadcast?: AuthBroadcast) {
  let now = START;
  const gateway = fakeAuthGateway();
  const pending = memoryPendingSignIn();
  const auth = createAuthService({
    gateway,
    pending,
    random: countingRandom(),
    sha256: fakeSha256,
    clock: { now: () => now },
    ...(broadcast ? { broadcast } : {}),
  });
  const advance = (ms: number) => {
    now += ms;
  };
  /** Starts a sign-in and comes back from GitHub with a code it accepts. */
  const signInWith = async (code = 'good-code') => {
    await auth.signIn();
    const state = pending.held?.state ?? '';
    gateway.codes.add(code);
    return auth.restore(`?code=${code}&state=${state}`);
  };
  return { auth, gateway, pending, advance, signInWith };
}

describe('signing in', () => {
  it('leaves for GitHub with a state and the verifier’s challenge, and keeps both for the callback', async () => {
    const { auth, gateway, pending } = world();
    await auth.signIn();
    const held = pending.held;
    expect(held).not.toBeNull();
    const challenge = Buffer.from(`sha256(${held?.verifier})`).toString('base64url');
    expect(gateway.calls).toEqual([
      { kind: 'start', state: held?.state, codeChallenge: challenge },
    ]);
    expect(held?.state).not.toBe(held?.verifier);
  });

  it('redeems the code with the verifier and is signed in', async () => {
    const { gateway, pending, auth } = world();
    await auth.signIn();
    const verifier = pending.held?.verifier;
    gateway.codes.add('c1');
    await auth.restore(`?code=c1&state=${pending.held?.state}`);
    expect(auth.state()).toEqual({ status: 'signed-in' });
    expect(gateway.calls).toContainEqual({ kind: 'exchange', code: 'c1', verifier });
    expect(await auth.tokenForRequest()).toBe('ghu_token1');
  });

  it('uses a pending sign-in once: the same callback again is a mismatch', async () => {
    const { auth, gateway, pending } = world();
    await auth.signIn();
    const query = `?code=c1&state=${pending.held?.state}`;
    gateway.codes.add('c1');
    await auth.restore(query);
    const again = world();
    // A second page load of the callback finds no pending sign-in and no cookie.
    expect(await again.auth.restore(query)).toEqual({
      status: 'signed-out',
      reason: 'state-mismatch',
    });
    expect(pending.held).toBeNull();
  });

  it('is signed out, saying so, when GitHub refuses the code', async () => {
    const { auth, pending } = world();
    await auth.signIn();
    expect(await auth.restore(`?code=used&state=${pending.held?.state}`)).toEqual({
      status: 'signed-out',
      reason: 'bad-code',
    });
  });

  it('is signed out, saying so, when the person said no', async () => {
    const { auth, pending } = world();
    await auth.signIn();
    expect(await auth.restore(`?error=access_denied&state=${pending.held?.state}`)).toEqual({
      status: 'signed-out',
      reason: 'denied',
    });
  });

  it('is signed out, saying so, on a callback for a sign-in that timed out', async () => {
    const { auth, pending, advance } = world();
    await auth.signIn();
    advance(11 * 60_000);
    expect(await auth.restore(`?code=c&state=${pending.held?.state}`)).toEqual({
      status: 'signed-out',
      reason: 'stale',
    });
  });

  it('keeps a session already held when a crafted callback arrives, redeeming nothing', async () => {
    const { auth, gateway } = world();
    gateway.hasCookie = true;
    expect(await auth.restore('?code=attacker&state=whatever')).toEqual({ status: 'signed-in' });
    expect(gateway.calls.some((call) => call.kind === 'exchange')).toBe(false);
  });

  it('is signed out, saying so, when the function answers a grant it should not have', async () => {
    const { auth, gateway, pending } = world();
    gateway.expiresInSeconds = 10 * 365 * 24 * 3600;
    await auth.signIn();
    gateway.codes.add('c');
    expect(await auth.restore(`?code=c&state=${pending.held?.state}`)).toEqual({
      status: 'signed-out',
      reason: 'malformed',
    });
  });

  it('is signed out, saying so, when the function cannot be reached for the code', async () => {
    const { auth, gateway, pending } = world();
    await auth.signIn();
    gateway.failWith = 'network';
    expect(await auth.restore(`?code=c&state=${pending.held?.state}`)).toEqual({
      status: 'signed-out',
      reason: 'network',
    });
  });
});

describe('restoring a session on a page load', () => {
  it('is signed in from the cookie', async () => {
    const { auth, gateway } = world();
    gateway.hasCookie = true;
    expect(await auth.restore('')).toEqual({ status: 'signed-in' });
  });

  it('is signed out with nothing to say when there is no cookie', async () => {
    const { auth } = world();
    expect(await auth.restore('')).toEqual({ status: 'signed-out', reason: null });
  });

  it('is signed out, saying the access was removed, when the cookie’s token is revoked', async () => {
    const { auth, gateway } = world();
    gateway.hasCookie = true;
    gateway.revoked = true;
    expect(await auth.restore('')).toEqual({ status: 'signed-out', reason: 'revoked' });
  });

  it('is signed out, saying the function is unreachable, when offline', async () => {
    const { auth, gateway } = world();
    gateway.hasCookie = true;
    gateway.failWith = 'network';
    expect(await auth.restore('')).toEqual({ status: 'signed-out', reason: 'network' });
  });

  it('lets a failure that is no sign-in failure through, rather than calling it a sign-out', async () => {
    const { auth, gateway } = world();
    gateway.refresh = async () => {
      throw new RangeError('a bug in the adapter');
    };
    await expect(auth.restore('')).rejects.toThrow(RangeError);
    expect(auth.state()).toEqual({ status: 'checking' });
  });

  it('tells its listeners, and stops when unsubscribed', async () => {
    const { auth, gateway } = world();
    gateway.hasCookie = true;
    const seen: string[] = [];
    const stop = auth.subscribe(() => seen.push(auth.state().status));
    expect(auth.state()).toEqual({ status: 'checking' });
    await auth.restore('');
    stop();
    await auth.signOut();
    expect(seen).toEqual(['signed-in']);
  });
});

describe('a token for a request', () => {
  it('is the session’s own until the refresh margin', async () => {
    const { auth, signInWith, advance, gateway } = world();
    await signInWith();
    advance(8 * HOUR - REFRESH_MARGIN_MS - 1);
    expect(await auth.tokenForRequest()).toBe('ghu_token1');
    expect(gateway.calls.filter((call) => call.kind === 'refresh')).toHaveLength(0);
  });

  it('is refreshed before it expires, and the new one is used after', async () => {
    const { auth, signInWith, advance, gateway } = world();
    await signInWith();
    advance(8 * HOUR - REFRESH_MARGIN_MS);
    expect(await auth.tokenForRequest()).toBe('ghu_token2');
    expect(await auth.tokenForRequest()).toBe('ghu_token2');
    expect(gateway.calls.filter((call) => call.kind === 'refresh')).toHaveLength(1);
  });

  it('is refreshed once for many callers at the same moment, so a rotated token is spent once', async () => {
    const { auth, signInWith, advance, gateway } = world();
    await signInWith();
    advance(8 * HOUR);
    gateway.holdRefreshes = true;
    const tokens = Promise.all([auth.tokenForRequest(), auth.tokenForRequest()]);
    await Promise.resolve();
    gateway.release();
    expect(await tokens).toEqual(['ghu_token2', 'ghu_token2']);
    expect(gateway.calls.filter((call) => call.kind === 'refresh')).toHaveLength(1);
  });

  it('is the old one, still good, when the refresh is due but the network is down', async () => {
    const { auth, signInWith, advance, gateway } = world();
    await signInWith();
    advance(8 * HOUR - 60_000);
    gateway.failWith = 'network';
    expect(await auth.tokenForRequest()).toBe('ghu_token1');
    expect(auth.state()).toEqual({ status: 'signed-in' });
  });

  it('is refused when it has expired and the network is down, still signed in to try again', async () => {
    const { auth, signInWith, advance, gateway } = world();
    await signInWith();
    advance(8 * HOUR);
    gateway.failWith = 'network';
    await expect(auth.tokenForRequest()).rejects.toMatchObject({ kind: 'network' });
    expect(auth.state()).toEqual({ status: 'signed-in' });
    gateway.failWith = null;
    expect(await auth.tokenForRequest()).toBe('ghu_token2');
  });

  it('signs out, saying the access was removed, when the refresh is revoked', async () => {
    const { auth, signInWith, advance, gateway } = world();
    await signInWith();
    advance(8 * HOUR - 60_000);
    gateway.revoked = true;
    await expect(auth.tokenForRequest()).rejects.toMatchObject({ kind: 'revoked' });
    expect(auth.state()).toEqual({ status: 'signed-out', reason: 'revoked' });
    await expect(auth.tokenForRequest()).rejects.toMatchObject({ kind: 'no-session' });
  });

  it('signs out, saying so, when the refresh cookie is gone', async () => {
    const { auth, signInWith, advance, gateway } = world();
    await signInWith();
    advance(8 * HOUR);
    gateway.hasCookie = false;
    await expect(auth.tokenForRequest()).rejects.toMatchObject({ kind: 'no-session' });
    expect(auth.state()).toEqual({ status: 'signed-out', reason: 'no-session' });
  });

  it('signs out when the refresh answers a grant it should not have', async () => {
    const { auth, signInWith, advance, gateway } = world();
    await signInWith();
    advance(8 * HOUR);
    gateway.expiresInSeconds = 1;
    await expect(auth.tokenForRequest()).rejects.toMatchObject({ kind: 'malformed' });
    expect(auth.state()).toEqual({ status: 'signed-out', reason: 'malformed' });
  });

  it('is refused before any sign-in', async () => {
    const { auth } = world();
    await expect(auth.tokenForRequest()).rejects.toBeInstanceOf(AuthError);
  });
});

describe('a token GitHub rejects', () => {
  it('signs out, saying the access was removed, when the refresh is refused too', async () => {
    const { auth, signInWith, gateway } = world();
    await signInWith();
    gateway.revoked = true;
    await auth.rejected('ghu_token1');
    expect(auth.state()).toEqual({ status: 'signed-out', reason: 'revoked' });
  });

  it('is refreshed once and kept when the refresh works (a clock that ran slow)', async () => {
    const { auth, signInWith } = world();
    await signInWith();
    await auth.rejected('ghu_token1');
    expect(auth.state()).toEqual({ status: 'signed-in' });
    expect(await auth.tokenForRequest()).toBe('ghu_token2');
  });

  it('signs out, saying the service is unreachable, when the refresh cannot be made', async () => {
    const { auth, signInWith, gateway } = world();
    await signInWith();
    gateway.failWith = 'network';
    await auth.rejected('ghu_token1');
    expect(auth.state()).toEqual({ status: 'signed-out', reason: 'network' });
  });

  it('ends nothing when it is a token a refresh already replaced', async () => {
    const { auth, signInWith, advance, gateway } = world();
    await signInWith();
    advance(8 * HOUR);
    await auth.tokenForRequest();
    await auth.rejected('ghu_token1');
    expect(auth.state()).toEqual({ status: 'signed-in' });
    expect(gateway.calls.filter((call) => call.kind === 'refresh')).toHaveLength(1);
  });
});

describe('other tabs', () => {
  it('end their sessions when one tab signs out, without a sign-out call of their own', async () => {
    const channel = memoryAuthChannel();
    const a = world(channel.tab());
    const b = world(channel.tab());
    await a.signInWith();
    b.gateway.hasCookie = true;
    await b.auth.restore('');
    await a.auth.signOut();
    expect(b.auth.state()).toEqual({ status: 'signed-out', reason: null });
    await expect(b.auth.tokenForRequest()).rejects.toMatchObject({ kind: 'no-session' });
    expect(b.gateway.calls.some((call) => call.kind === 'sign-out')).toBe(false);
    expect(a.auth.state()).toEqual({ status: 'signed-out', reason: null });
  });

  it('are not told when the sign-out could not reach the function', async () => {
    const channel = memoryAuthChannel();
    const a = world(channel.tab());
    const b = world(channel.tab());
    await a.signInWith();
    b.gateway.hasCookie = true;
    await b.auth.restore('');
    a.gateway.failWith = 'network';
    await a.auth.signOut();
    expect(b.auth.state()).toEqual({ status: 'signed-in' });
  });

  it('stays signed out when told again', async () => {
    const channel = memoryAuthChannel();
    const a = world(channel.tab());
    const b = world(channel.tab());
    await b.auth.restore('');
    const seen: unknown[] = [];
    b.auth.subscribe(() => seen.push(b.auth.state()));
    a.gateway.hasCookie = true;
    await a.auth.restore('');
    await a.auth.signOut();
    expect(seen).toEqual([]);
  });
});

describe('signing out', () => {
  it('clears the cookie and revokes the token at the function, and keeps no token', async () => {
    const { auth, signInWith, gateway } = world();
    await signInWith();
    await auth.signOut();
    expect(gateway.calls.at(-1)).toEqual({ kind: 'sign-out', accessToken: 'ghu_token1' });
    expect(gateway.hasCookie).toBe(false);
    expect(auth.state()).toEqual({ status: 'signed-out', reason: null });
    await expect(auth.tokenForRequest()).rejects.toMatchObject({ kind: 'no-session' });
  });

  it('waits for a refresh in flight, revokes its new token, and drops nothing back in', async () => {
    const { auth, signInWith, advance, gateway } = world();
    await signInWith();
    advance(8 * HOUR);
    gateway.holdRefreshes = true;
    const token = auth.tokenForRequest();
    const out = auth.signOut();
    await Promise.resolve();
    gateway.release();
    await out;
    expect(await token).toBe('ghu_token2');
    expect(gateway.calls.at(-1)).toEqual({ kind: 'sign-out', accessToken: 'ghu_token2' });
    expect(gateway.hasCookie).toBe(false);
    expect(auth.state()).toEqual({ status: 'signed-out', reason: null });
    await expect(auth.tokenForRequest()).rejects.toMatchObject({ kind: 'no-session' });
  });

  it('drops a refresh that lands after another tab signed out', async () => {
    const channel = memoryAuthChannel();
    const other = channel.tab();
    const { auth, signInWith, advance, gateway } = world(channel.tab());
    await signInWith();
    advance(8 * HOUR - 60_000);
    gateway.holdRefreshes = true;
    const token = auth.tokenForRequest();
    await Promise.resolve();
    other.announceSignOut();
    gateway.release();
    await expect(token).rejects.toMatchObject({ kind: 'no-session' });
    expect(auth.state()).toEqual({ status: 'signed-out', reason: null });
  });

  it('starts no refresh once it has begun, even while it waits on one in flight', async () => {
    const { auth, gateway } = world();
    gateway.hasCookie = true;
    gateway.holdRefreshes = true;
    const restoring = auth.restore('');
    await Promise.resolve();
    const out = auth.signOut();
    await expect(auth.tokenForRequest()).rejects.toMatchObject({ kind: 'no-session' });
    gateway.release();
    await Promise.all([restoring, out]);
    expect(gateway.calls.map((call) => call.kind)).toEqual(['refresh', 'sign-out']);
  });

  it('starts no refresh for a due token while it waits on a restore in flight', async () => {
    const { auth, signInWith, advance, gateway } = world();
    await signInWith();
    gateway.holdRefreshes = true;
    const restoring = auth.restore('');
    await Promise.resolve();
    const out = auth.signOut();
    advance(8 * HOUR - 60_000);
    const token = auth.tokenForRequest();
    gateway.release();
    await Promise.all([restoring, out, token.catch(() => undefined)]);
    // The restore's refresh alone: none started after the sign-out began to land after it.
    expect(gateway.calls.filter((call) => call.kind === 'refresh')).toHaveLength(1);
    expect(gateway.calls.at(-1)?.kind).toBe('sign-out');
    expect(gateway.hasCookie).toBe(false);
  });

  it('revokes the token a restore in flight was granted, never showing it signed in', async () => {
    const { auth, gateway } = world();
    gateway.hasCookie = true;
    gateway.holdRefreshes = true;
    const seen: string[] = [];
    auth.subscribe(() => seen.push(auth.state().status));
    const restoring = auth.restore('');
    await Promise.resolve();
    const out = auth.signOut();
    gateway.release();
    await Promise.all([restoring, out]);
    expect(gateway.calls.at(-1)).toEqual({ kind: 'sign-out', accessToken: 'ghu_token1' });
    expect(seen).not.toContain('signed-in');
  });

  it('says so when the function cannot be reached to forget this browser', async () => {
    const { auth, signInWith, gateway } = world();
    await signInWith();
    gateway.failWith = 'network';
    await auth.signOut();
    expect(auth.state()).toEqual({ status: 'signed-out', reason: 'network' });
    await expect(auth.tokenForRequest()).rejects.toMatchObject({ kind: 'no-session' });
  });

  it('drops a restore that lands after a sign-out', async () => {
    const { auth, gateway } = world();
    gateway.hasCookie = true;
    gateway.holdRefreshes = true;
    const restoring = auth.restore('');
    await Promise.resolve();
    const out = auth.signOut();
    gateway.release();
    await Promise.all([restoring, out]);
    expect(gateway.calls.map((call) => call.kind)).toEqual(['refresh', 'sign-out']);
    expect(gateway.hasCookie).toBe(false);
    expect(auth.state()).toEqual({ status: 'signed-out', reason: null });
    await expect(auth.tokenForRequest()).rejects.toMatchObject({ kind: 'no-session' });
  });
});
