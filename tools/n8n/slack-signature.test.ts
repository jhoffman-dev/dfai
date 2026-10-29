import { describe, expect, it } from 'vitest';
import { WebhookRefusal } from './standard-webhook.ts';
import {
  SIGNING_SECRET_PLACEHOLDER,
  slackSignature,
  verifySlackSignature,
} from './slack-signature.ts';
import { NOW, SECRET, signedHeaders, SIGNED_AT, SLACK_VECTOR, utf8 } from './slack-fixtures.ts';

/*
 * Slack's request signature (#104), checked in plain JavaScript: Slack's
 * documented example, Node's crypto on other bodies, and every way a
 * request is refused.
 */

const vectorHeaders = (overrides: Record<string, string> = {}) => ({
  'x-slack-request-timestamp': SLACK_VECTOR.timestamp,
  'x-slack-signature': SLACK_VECTOR.signature,
  ...overrides,
});
const VECTOR_NOW = Number(SLACK_VECTOR.timestamp) * 1000;
const vectorCheck = { signingSecret: SLACK_VECTOR.signingSecret, now: VECTOR_NOW };

const refusal = (run: () => void) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WebhookRefusal);
    return (error as Error).message;
  }
  throw new Error('not refused');
};

describe('Slack’s documented example', () => {
  it('signs to the documented signature', () => {
    expect(
      slackSignature(
        utf8(SLACK_VECTOR.signingSecret),
        SLACK_VECTOR.timestamp,
        utf8(SLACK_VECTOR.body),
      ),
    ).toBe(SLACK_VECTOR.signature);
  });

  it('is accepted, on a clock at its timestamp', () => {
    expect(() =>
      verifySlackSignature(
        { headers: vectorHeaders(), body: utf8(SLACK_VECTOR.body) },
        vectorCheck,
      ),
    ).not.toThrow();
  });

  it('agrees with Node’s crypto on a body beyond ASCII and one over a block long', () => {
    for (const body of ['{"text":"Café — naïve 😀"}', 'x'.repeat(200)]) {
      const delivery = { headers: signedHeaders(body), body: utf8(body) };
      expect(() =>
        verifySlackSignature(delivery, { signingSecret: SECRET, now: NOW }),
      ).not.toThrow();
    }
  });
});

describe('a request that is not Slack’s, now', () => {
  it('is refused under another secret', () => {
    const delivery = { headers: vectorHeaders(), body: utf8(SLACK_VECTOR.body) };
    expect(
      refusal(() => verifySlackSignature(delivery, { ...vectorCheck, signingSecret: SECRET })),
    ).toBe('x-slack-signature: does not match');
  });

  it('is refused with one byte of the body changed', () => {
    const delivery = { headers: vectorHeaders(), body: utf8(`${SLACK_VECTOR.body}x`) };
    expect(refusal(() => verifySlackSignature(delivery, vectorCheck))).toMatch(/does not match/);
  });

  it.each([
    ['five minutes and a second late', 301],
    ['five minutes and a second early', -301],
  ])('is refused %s, and taken at exactly five minutes', (_, seconds) => {
    const delivery = { headers: vectorHeaders(), body: utf8(SLACK_VECTOR.body) };
    expect(
      refusal(() =>
        verifySlackSignature(delivery, { ...vectorCheck, now: VECTOR_NOW + seconds * 1000 }),
      ),
    ).toBe('x-slack-request-timestamp: more than five minutes from now');
    const edge = VECTOR_NOW + Math.sign(seconds) * 300 * 1000;
    expect(() => verifySlackSignature(delivery, { ...vectorCheck, now: edge })).not.toThrow();
  });

  it('is refused with a timestamp signed fresh but sent stale (the replay Slack’s window stops)', () => {
    const stale = String(SIGNED_AT - 600);
    const body = '{"type":"event_callback"}';
    const delivery = { headers: signedHeaders(body, SECRET, stale), body: utf8(body) };
    expect(
      refusal(() => verifySlackSignature(delivery, { signingSecret: SECRET, now: NOW })),
    ).toMatch(/more than five minutes/);
  });

  it.each([
    ['no timestamp', { 'x-slack-request-timestamp': undefined }],
    ['a timestamp that is not seconds', { 'x-slack-request-timestamp': '1531420618.5' }],
  ])('is refused with %s', (_, overrides) => {
    const headers = Object.fromEntries(
      Object.entries(vectorHeaders()).map(([name, value]) => [
        name,
        name in overrides ? (overrides as Record<string, string | undefined>)[name] : value,
      ]),
    );
    const delivery = { headers, body: utf8(SLACK_VECTOR.body) };
    expect(refusal(() => verifySlackSignature(delivery, vectorCheck))).toMatch(
      /^x-slack-request-timestamp: missing/,
    );
  });

  it('is refused with no signature, or a v1 one', () => {
    for (const signature of ['', SLACK_VECTOR.signature.replace('v0=', 'v1=')]) {
      const delivery = {
        headers: vectorHeaders({ 'x-slack-signature': signature }),
        body: utf8(SLACK_VECTOR.body),
      };
      expect(refusal(() => verifySlackSignature(delivery, vectorCheck))).toMatch(/does not match/);
    }
  });

  it('is refused while the secret is the placeholder or empty, even if signed with it', () => {
    for (const secret of [SIGNING_SECRET_PLACEHOLDER, '']) {
      const body = '{}';
      const delivery = { headers: signedHeaders(body, secret), body: utf8(body) };
      expect(
        refusal(() => verifySlackSignature(delivery, { signingSecret: secret, now: NOW })),
      ).toMatch(/signing secret is not set/);
    }
  });

  it('is refused on a clock that is not a number', () => {
    const delivery = { headers: vectorHeaders(), body: utf8(SLACK_VECTOR.body) };
    expect(
      refusal(() => verifySlackSignature(delivery, { ...vectorCheck, now: Number.NaN })),
    ).toMatch(/clock is not a number/);
  });
});
