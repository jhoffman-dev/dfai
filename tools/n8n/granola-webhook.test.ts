import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bodyExcerpt,
  MAX_BODY_BYTES,
  UnreadableWebhookBody,
  verifyGranolaWebhook,
  webhookNoteId,
} from './granola-webhook.ts';
import { VECTOR, VECTOR_NOW, vectorHeaders } from './standard-webhook-vector.ts';

/*
 * A Granola webhook: the note id is read from the body only once the
 * signature over that body holds, and it goes into the fetch's URL, so it
 * must be a note id and nothing else.
 */

const KEY = Buffer.from(VECTOR.secret.slice('whsec_'.length), 'base64');

/** A delivery signed as Granola signs one, with Node's crypto as the independent signer. */
function signed(body: string) {
  const mac = createHmac('sha256', KEY).update(`${VECTOR.id}.${VECTOR.timestamp}.${body}`);
  const headers = vectorHeaders({ 'webhook-signature': `v1,${mac.digest('base64')}` });
  return { headers, body: Buffer.from(body) };
}
const check = { secret: VECTOR.secret, now: VECTOR_NOW };

describe('a verified Granola webhook', () => {
  it('names the note to fetch, and the webhook it came in', () => {
    const delivery = signed('{"event":"note.generated","note_id":"not_4kTq2mWxLp4Rz7"}');
    expect(verifyGranolaWebhook(delivery, check)).toEqual({
      signed: true,
      webhookId: VECTOR.id,
      noteId: 'not_4kTq2mWxLp4Rz7',
    });
  });

  it('is refused, not thrown, before its body is read when the signature fails', () => {
    const delivery = { ...signed('not even JSON'), body: Buffer.from('{"note_id":"not_x"}') };
    expect(verifyGranolaWebhook(delivery, check)).toEqual({
      signed: false,
      reason: 'webhook-signature: no v1 signature matches',
    });
  });

  it('is refused on its size alone past 64 KB, even when Granola signed it', () => {
    const pad = (n: number) => `{"note_id":"not_4kTq2mWxLp4Rz7","pad":"${'x'.repeat(n)}"}`;
    const overhead = pad(0).length;
    expect(verifyGranolaWebhook(signed(pad(MAX_BODY_BYTES - overhead)), check)).toMatchObject({
      signed: true,
    });
    expect(verifyGranolaWebhook(signed(pad(MAX_BODY_BYTES - overhead + 1)), check)).toEqual({
      signed: false,
      reason: 'body: over 65536 bytes',
    });
  });

  it.each([
    ['no note id where the check looks', '{"data":{"id":"not_4kTq2mWxLp4Rz7"}}', /no note_id/],
    ['not JSON', 'note_id=not_4kTq2mWxLp4Rz7', /not JSON/],
  ])('is unreadable, not refused, when signed but %s, quoting it', (_, body, why) => {
    const run = () => verifyGranolaWebhook(signed(body), check);
    expect(run).toThrow(UnreadableWebhookBody);
    expect(run).toThrow(why);
    expect(run).toThrow(`it begins: ${body}`);
  });

  it('refuses, never throws, a fault before the signature is proven: it may not be Granola’s', () => {
    const delivery = { headers: vectorHeaders(), body: null as unknown as Uint8Array };
    expect(verifyGranolaWebhook(delivery, check)).toEqual({
      signed: false,
      reason: expect.stringMatching(/^a fault before the signature was proven: TypeError/),
    });
  });

  it('reads a signed body that is not UTF-8 as unreadable', () => {
    const body = Buffer.from([0x7b, 0xff, 0x7d]);
    const mac = createHmac('sha256', KEY).update(
      Buffer.concat([Buffer.from(`${VECTOR.id}.${VECTOR.timestamp}.`), body]),
    );
    const headers = vectorHeaders({ 'webhook-signature': `v1,${mac.digest('base64')}` });
    expect(() => verifyGranolaWebhook({ headers, body }, check)).toThrow(UnreadableWebhookBody);
    expect(() => verifyGranolaWebhook({ headers, body }, check)).toThrow(
      /not UTF-8; it begins: \{\\xff\}$/,
    );
  });
});

describe('the excerpt of an unreadable body', () => {
  it('keeps printable ASCII and writes every other byte as \\xNN, so it cannot forge a line', () => {
    expect(bodyExcerpt(Buffer.from('a\r\nSource ID: x\u0000é'))).toBe(
      'a\\x0d\\x0aSource ID: x\\x00\\xc3\\xa9',
    );
  });

  it('quotes the first 200 bytes and marks the rest as cut', () => {
    expect(bodyExcerpt(Buffer.from('y'.repeat(200)))).toBe('y'.repeat(200));
    expect(bodyExcerpt(Buffer.from('y'.repeat(201)))).toBe(`${'y'.repeat(200)}…`);
  });
});

describe('the note id in a webhook’s body', () => {
  it.each([
    ['at the top', '{"note_id":"not_4kTq2mWxLp4Rz7"}'],
    ['under data', '{"type":"note.generated","data":{"note_id":"not_4kTq2mWxLp4Rz7"}}'],
  ])('is read %s', (_, body) => {
    expect(webhookNoteId(body)).toBe('not_4kTq2mWxLp4Rz7');
  });

  it.each([
    ['a body that is not JSON', 'note_id=not_1', /not JSON/],
    ['a list', '["not_1"]', /no note_id/],
    ['no note_id', '{"id":"not_1"}', /no note_id/],
    ['a number', '{"note_id":7}', /no note_id/],
    ['an empty id', '{"note_id":""}', /no note_id/],
    ['a path that climbs', '{"note_id":"../../v1/notes"}', /no note_id/],
    ['a query in it', '{"note_id":"not_1?include=x"}', /no note_id/],
    ['a slash', '{"data":{"note_id":"not_1/transcript"}}', /no note_id/],
    ['an id past 64 characters', `{"note_id":"${'n'.repeat(65)}"}`, /no note_id/],
  ])('is refused in %s', (_, body, why) => {
    expect(() => webhookNoteId(body)).toThrow(why);
  });
});
