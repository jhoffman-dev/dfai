import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacSha256, sha256 } from './sha256.ts';
import {
  base64Bytes,
  base64Text,
  TIMESTAMP_TOLERANCE_SECONDS,
  utf8Bytes,
  utf8Text,
  verifyStandardWebhook,
  WebhookRefusal,
  type WebhookCheck,
} from './standard-webhook.ts';
import { VECTOR, VECTOR_NOW, vectorHeaders } from './standard-webhook-vector.ts';

/*
 * The signature check in plain JavaScript (P28-14): Node's own crypto is the
 * oracle for the hash, Buffer for the encodings, and the Standard Webhooks
 * spec's vector for the whole check.
 */

const body = Buffer.from(VECTOR.body);
const check: WebhookCheck = { secret: VECTOR.secret, now: VECTOR_NOW };
const verify = (headers: unknown, bytes: Uint8Array = body, given = check) =>
  verifyStandardWebhook({ headers, body: bytes }, given);

/** Deterministic bytes of a given length, no RNG. */
const bytesOf = (length: number, seed: number) =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + seed * 17 + 7) % 256);

describe('SHA-256 and HMAC-SHA256 in plain JavaScript', () => {
  // Every padding case: under, at and past one block, and many blocks.
  const lengths = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_000];

  it.each(lengths)('hash %i bytes as Node’s crypto does', (length) => {
    const message = bytesOf(length, length);
    expect(Buffer.from(sha256(message)).toString('hex')).toBe(
      createHash('sha256').update(message).digest('hex'),
    );
  });

  it.each([0, 16, 32, 64, 65, 200])('sign under a %i-byte key as Node’s crypto does', (size) => {
    const key = bytesOf(size, 3);
    const message = bytesOf(300, size);
    expect(Buffer.from(hmacSha256(key, message)).toString('hex')).toBe(
      createHmac('sha256', key).update(message).digest('hex'),
    );
  });

  it('hashes "abc" to FIPS 180-4’s example digest', () => {
    expect(Buffer.from(sha256(Buffer.from('abc'))).toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('the encodings', () => {
  it.each([0, 1, 2, 3, 4, 5, 32, 100])('write and read %i bytes of base64 as Buffer does', (n) => {
    const bytes = bytesOf(n, n + 1);
    const text = Buffer.from(bytes).toString('base64');
    expect(base64Text(bytes)).toBe(text);
    expect(Buffer.from(base64Bytes(text) ?? [])).toEqual(Buffer.from(bytes));
  });

  it.each(['abc', 'a_bc', 'abcde', 'ab=c', 'YQ'])(
    'refuse %s, which is not padded base64',
    (text) => {
      expect(base64Bytes(text)).toBeNull();
    },
  );

  it('writes and reads UTF-8 as Buffer does, astral and all', () => {
    const text = 'Larkspur — Mara Quill 🚀 é ü 漢';
    expect(Buffer.from(utf8Bytes(text))).toEqual(Buffer.from(text, 'utf8'));
    expect(utf8Text(Buffer.from(text, 'utf8'))).toBe(text);
    expect(Buffer.from(utf8Bytes('\ud800'))).toEqual(Buffer.from('�', 'utf8'));
  });

  it.each([
    ['a lone continuation byte', [0x80]],
    ['a cut-off sequence', [0xe2, 0x82]],
    ['a lead without a continuation', [0xc3, 0x41]],
    ['an overlong lead', [0xc0, 0xaf]],
  ])('refuses %s as not UTF-8', (_, bytes) => {
    expect(() => utf8Text(Uint8Array.from(bytes))).toThrow(/not UTF-8/);
  });
});

describe('a Standard Webhooks delivery', () => {
  it('passes with the spec’s known vector, and gives the webhook’s id', () => {
    expect(verify(vectorHeaders())).toBe(VECTOR.id);
  });

  it('passes when any of several signatures matches (a rotated secret)', () => {
    const rotated = `v1,bm90IHRoaXMgb25l v1a,ignored ${VECTOR.signature}`;
    expect(verify(vectorHeaders({ 'webhook-signature': rotated }))).toBe(VECTOR.id);
  });

  it('is refused under a wrong secret', () => {
    const wrong = { ...check, secret: 'whsec_' + Buffer.from('not the secret').toString('base64') };
    expect(() => verify(vectorHeaders(), body, wrong)).toThrow(WebhookRefusal);
    expect(() => verify(vectorHeaders(), body, wrong)).toThrow(/no v1 signature matches/);
  });

  it.each([
    ['older', -1],
    ['newer', 1],
  ])('is refused with a timestamp five minutes and a second %s than now', (_, sign) => {
    const now = VECTOR_NOW - sign * (TIMESTAMP_TOLERANCE_SECONDS + 1) * 1000;
    expect(() => verify(vectorHeaders(), body, { ...check, now })).toThrow(/five minutes/);
    // Right at the edge it is still fresh.
    const edge = VECTOR_NOW - sign * TIMESTAMP_TOLERANCE_SECONDS * 1000;
    expect(verify(vectorHeaders(), body, { ...check, now: edge })).toBe(VECTOR.id);
  });

  it('is refused when the body is not the one signed, by one byte', () => {
    expect(() => verify(vectorHeaders(), Buffer.from('{"test": 2432232315}'))).toThrow(
      /no v1 signature/,
    );
  });

  it('is refused when the id or timestamp is not the one signed', () => {
    expect(() => verify(vectorHeaders({ 'webhook-id': 'msg_other' }))).toThrow(/no v1 signature/);
    const later = String(Number(VECTOR.timestamp) + 1);
    expect(() => verify(vectorHeaders({ 'webhook-timestamp': later }))).toThrow(/no v1 signature/);
  });

  it.each([
    ['no headers at all', null],
    ['no webhook-id', { ...vectorHeaders(), 'webhook-id': undefined }],
    ['an empty webhook-id', vectorHeaders({ 'webhook-id': '' })],
    ['no timestamp', { ...vectorHeaders(), 'webhook-timestamp': undefined }],
    ['a timestamp that is not seconds', vectorHeaders({ 'webhook-timestamp': '1614265330.5' })],
    ['no signature', { ...vectorHeaders(), 'webhook-signature': undefined }],
    [
      'the signature without its v1,',
      vectorHeaders({ 'webhook-signature': VECTOR.signature.slice(3) }),
    ],
    [
      'a v1a signature only',
      vectorHeaders({ 'webhook-signature': `v1a,${VECTOR.signature.slice(3)}` }),
    ],
    [
      'the signature cut short',
      vectorHeaders({ 'webhook-signature': VECTOR.signature.slice(0, -2) }),
    ],
  ])('is refused with %s', (_, headers) => {
    expect(() => verify(headers)).toThrow(WebhookRefusal);
  });

  it.each([
    ['empty', ''],
    ['without whsec_', VECTOR.secret.slice('whsec_'.length)],
    ['the placeholder', 'whsec_PASTE_THE_SECRET_FROM_GRANOLA_HERE'],
    ['whsec_ and nothing', 'whsec_'],
  ])('is refused, never passed, while the secret is %s', (_, secret) => {
    expect(() => verify(vectorHeaders(), body, { ...check, secret })).toThrow(
      /webhook secret is not set/,
    );
  });
});
