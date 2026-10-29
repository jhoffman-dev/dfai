import { describe, expect, it } from 'vitest';
import {
  MAX_SLACK_BODY_BYTES,
  OWNER_PLACEHOLDER,
  type SlackCaptureSettings,
  UnreadableSlackRequest,
  verifySlackRequest,
} from './slack-request.ts';
import {
  CHANNEL,
  NOW,
  OWNER,
  reactionBody,
  SECRET,
  SETTINGS,
  shortcutBody,
  signedHeaders,
  TS,
  utf8,
} from './slack-fixtures.ts';

/*
 * What a signed Slack request asks (#104): a shortcut or a reaction to save,
 * the URL check, or nothing; and a signed request that cannot be read.
 */

const check = { signingSecret: SECRET, now: NOW, settings: SETTINGS };
const signed = (body: string) => ({ headers: signedHeaders(body), body: utf8(body) });
const read = (body: string, settings: SlackCaptureSettings = SETTINGS) =>
  verifySlackRequest(signed(body), { ...check, settings });

describe('a message shortcut', () => {
  it('saves the message it was used on, as a task or a note by its callback', () => {
    expect(read(shortcutBody())).toEqual({
      signed: true,
      action: 'capture',
      via: 'shortcut',
      kind: 'task',
      channel: CHANNEL,
      ts: TS,
      userId: OWNER,
    });
    expect(read(shortcutBody({ callback_id: 'dfai_save_note' }))).toMatchObject({ kind: 'note' });
  });

  it('is ignored from anyone else, or as another app’s shortcut', () => {
    expect(read(shortcutBody({ user: { id: 'U0MARAQ111' } }))).toEqual({
      signed: true,
      action: 'ignore',
      reason: 'not your shortcut',
    });
    expect(read(shortcutBody({ callback_id: 'other' }))).toMatchObject({ action: 'ignore' });
  });

  it('reads the ts from the message when message_ts is not sent', () => {
    expect(read(shortcutBody({ message_ts: undefined }))).toMatchObject({ ts: TS });
  });
});

describe('a reaction', () => {
  it('saves a message with the note emoji as a note, the task emoji as a task, any skin tone', () => {
    expect(read(reactionBody())).toMatchObject({
      action: 'capture',
      via: 'reaction',
      kind: 'note',
    });
    expect(read(reactionBody({ reaction: 'ballot_box_with_check::skin-tone-3' }))).toMatchObject({
      kind: 'task',
    });
  });

  it.each([
    ['another emoji', { reaction: 'tada' }, 'another emoji'],
    ['someone else’s', { user: 'U0MARAQ111' }, 'not your reaction'],
    ['on a file', { item: { type: 'file', file: 'F1' } }, 'not on a message'],
    ['another event', { type: 'reaction_removed' }, 'another event'],
  ])('is ignored when %s', (_, event, reason) => {
    expect(read(reactionBody(event))).toEqual({ signed: true, action: 'ignore', reason });
  });
});

describe('the URL check', () => {
  it('hands on the challenge to echo', () => {
    const body = JSON.stringify({ type: 'url_verification', token: 't', challenge: 'c0ffee' });
    expect(read(body)).toEqual({ signed: true, action: 'challenge', challenge: 'c0ffee' });
  });
});

describe('a request refused', () => {
  it('is signed: false, with the reason, and nothing is read', () => {
    const body = reactionBody();
    const forged = { headers: signedHeaders(body, 'another-secret'), body: utf8(body) };
    expect(verifySlackRequest(forged, check)).toEqual({
      signed: false,
      reason: 'x-slack-signature: does not match',
    });
  });

  it('is refused before hashing when the body is over the cap', () => {
    const body = `{"x":"${'a'.repeat(MAX_SLACK_BODY_BYTES)}"}`;
    expect(verifySlackRequest(signed(body), check)).toEqual({
      signed: false,
      reason: `body: over ${MAX_SLACK_BODY_BYTES} bytes`,
    });
  });
});

describe('a request Slack signed that cannot be read', () => {
  it.each([
    ['not JSON', '{nope'],
    ['a form with no payload', 'command=%2Fdfai&text='],
    ['a channel that is not an id', shortcutBody({ channel: { id: '../x' } })],
    [
      'a ts that is not one',
      reactionBody({ item: { type: 'message', channel: CHANNEL, ts: '1&x=2' } }),
    ],
    ['no challenge', '{"type":"url_verification"}'],
  ])('throws UnreadableSlackRequest for %s, quoting the body safely', (_, body) => {
    expect(() => read(body)).toThrow(UnreadableSlackRequest);
    expect(() => read(body)).toThrow(/^signed by Slack, but /);
  });

  it('quotes a control character in the body as \\xNN, never raw', () => {
    const body = '{nope\r\nBcc: x';
    expect(() => read(body)).toThrow('it begins: {nope\\x0d\\x0aBcc: x');
  });

  it('is unreadable when the body is not UTF-8', () => {
    const body = new Uint8Array([0x7b, 0xff, 0x7d]);
    const delivery = { headers: signedHeaders(body), body };
    expect(() => verifySlackRequest(delivery, check)).toThrow(/not UTF-8/);
  });

  it('quotes no verification token: Slack’s deprecated `token` is redacted', () => {
    const body =
      '{"token":"xyzz0WbapA4vBCDEFasx0q6G","type":"event_callback","event":{"type":"reaction_added","user":"nope"}}';
    expect(() => read(body)).toThrow(/"token":"…"/);
    expect(() => read(body)).not.toThrow(/xyzz0Wbap/);
    const form = `token=xyzz0WbapA4vBCDEFasx0q6G&payload=%7Bnope`;
    expect(() => read(form)).not.toThrow(/xyzz0Wbap/);
  });
});

describe('a workflow not set up', () => {
  it('answers a plain 200 while OWNER is the placeholder: no email for every reaction', () => {
    const settings = { ...SETTINGS, ownerUserId: OWNER_PLACEHOLDER };
    expect(read(reactionBody(), settings)).toEqual({
      signed: true,
      action: 'ignore',
      reason: 'OWNER is not set: paste your Slack member id into "Verify Slack signature"',
    });
  });

  it('refuses in silence when reading the headers fails, before any signature is proven', () => {
    const headers = new Proxy(
      {},
      {
        get: () => {
          throw new Error('no headers');
        },
      },
    );
    expect(verifySlackRequest({ headers, body: utf8('{}') }, check)).toMatchObject({
      signed: false,
    });
  });

  it('refuses in silence when there is no raw body', () => {
    expect(verifySlackRequest({ headers: signedHeaders('{}'), body: null }, check)).toEqual({
      signed: false,
      reason: 'no raw body',
    });
  });
});
