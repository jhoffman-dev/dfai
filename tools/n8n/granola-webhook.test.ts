import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGranolaWebhook, webhookNoteId } from './granola-webhook.ts';
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
      webhookId: VECTOR.id,
      noteId: 'not_4kTq2mWxLp4Rz7',
    });
  });

  it('is refused before its body is read when the signature fails', () => {
    const delivery = { ...signed('not even JSON'), body: Buffer.from('{"note_id":"not_x"}') };
    expect(() => verifyGranolaWebhook(delivery, check)).toThrow(/signature/);
  });

  it('reads a signed body that is not UTF-8 as a refusal', () => {
    const body = Buffer.from([0x7b, 0xff, 0x7d]);
    const mac = createHmac('sha256', KEY).update(
      Buffer.concat([Buffer.from(`${VECTOR.id}.${VECTOR.timestamp}.`), body]),
    );
    const headers = vectorHeaders({ 'webhook-signature': `v1,${mac.digest('base64')}` });
    expect(() => verifyGranolaWebhook({ headers, body }, check)).toThrow(/not UTF-8/);
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
