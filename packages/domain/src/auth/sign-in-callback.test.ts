import { describe, expect, it } from 'vitest';
import { readSignInCallback } from './sign-in-callback.ts';
import { PENDING_SIGN_IN_MS, type PendingSignIn } from './sign-in-request.ts';

/** #663, ADR-0052: GitHub's redirect back, read against the sign-in this tab started. */

const STATE = 'S'.repeat(43);
const VERIFIER = 'V'.repeat(43);
const STARTED = 1_000_000;
const pending: PendingSignIn = { state: STATE, verifier: VERIFIER, startedAt: STARTED };
const read = (query: string, over: { pending?: PendingSignIn | null; now?: number } = {}) =>
  readSignInCallback({ query, pending: pending, now: STARTED + 1000, ...over });

describe('the sign-in callback', () => {
  it('is no callback on an ordinary visit, whatever else the query holds', () => {
    expect(read('')).toEqual({ kind: 'none' });
    expect(read('?note=Inbox&view=board')).toEqual({ kind: 'none' });
  });

  it('hands over the code with the verifier the sign-in started with', () => {
    expect(read(`?code=0123abcd&state=${STATE}`)).toEqual({
      kind: 'code',
      code: '0123abcd',
      verifier: VERIFIER,
    });
  });

  it('is a mismatch when no sign-in was started in this tab', () => {
    expect(read(`?code=abc&state=${STATE}`, { pending: null })).toEqual({
      kind: 'failed',
      reason: 'state-mismatch',
    });
  });

  it.each([
    ['another state', `?code=abc&state=${'T'.repeat(43)}`],
    ['no state', '?code=abc'],
    ['an empty state', '?code=abc&state='],
    ['the state twice', `?code=abc&state=${STATE}&state=${STATE}`],
    ['the state with another beside it', `?code=abc&state=${STATE}&state=x`],
    // A crafted link must not choose the screen's message.
    ['an error with another state', `?error=access_denied&state=x`],
  ])('is a mismatch with %s', (_what, query) => {
    expect(read(query)).toEqual({ kind: 'failed', reason: 'state-mismatch' });
  });

  it('is stale after the pending sign-in’s time, and fresh up to it', () => {
    const query = `?code=abc&state=${STATE}`;
    expect(read(query, { now: STARTED + PENDING_SIGN_IN_MS }).kind).toBe('code');
    expect(read(query, { now: STARTED + PENDING_SIGN_IN_MS + 1 })).toEqual({
      kind: 'failed',
      reason: 'stale',
    });
  });

  it('is stale when the clock reads before the sign-in started', () => {
    expect(read(`?code=abc&state=${STATE}`, { now: STARTED - 1 })).toEqual({
      kind: 'failed',
      reason: 'stale',
    });
  });

  it('is denied when the person said no on GitHub', () => {
    expect(read(`?error=access_denied&state=${STATE}`)).toEqual({
      kind: 'failed',
      reason: 'denied',
    });
  });

  it('is refused for any other error GitHub sends back, even with a code beside it', () => {
    expect(read(`?error=redirect_uri_mismatch&state=${STATE}`)).toEqual({
      kind: 'failed',
      reason: 'refused',
    });
    expect(read(`?error=access_denied&error=x&code=abc&state=${STATE}`)).toEqual({
      kind: 'failed',
      reason: 'refused',
    });
  });

  it.each([
    ['no code', `?state=${STATE}`],
    ['an empty code', `?code=&state=${STATE}`],
    ['two codes', `?code=a&code=b&state=${STATE}`],
    ['a code with odd characters', `?code=a%20b&state=${STATE}`],
    ['an overlong code', `?code=${'a'.repeat(257)}&state=${STATE}`],
  ])('is malformed with %s', (_what, query) => {
    expect(read(query)).toEqual({ kind: 'failed', reason: 'malformed' });
  });
});
