import { hmacSha256 } from './sha256.ts';

/*
 * The Standard Webhooks signature check (standardwebhooks.com, "Verifying
 * webhook authenticity"), which Granola signs its webhooks with (ADR-0034).
 * Plain JavaScript like sha256.ts, so the compiled Code node runs on any
 * engine: no Buffer, atob, TextEncoder or crypto.
 */

/** Why a webhook was refused. The workflow answers it with a 401, which Granola does not retry. */
export class WebhookRefusal extends Error {
  override readonly name = 'WebhookRefusal';
}

/** How far a webhook's timestamp may be from now, either way, in seconds (the spec's five minutes). */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_TEXT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Standard base64 as bytes; null when it is not base64. */
export function base64Bytes(text: string): Uint8Array | null {
  if (!BASE64_TEXT.test(text)) return null;
  const digits = text.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((digits.length * 3) / 4));
  let bits = 0;
  let held = 0;
  let next = 0;
  for (const digit of digits) {
    held = (held << 6) | BASE64.indexOf(digit);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[next] = (held >> bits) & 0xff;
      next += 1;
    }
  }
  return bytes;
}

export function base64Text(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const digits = [18, 12, 6, 0].map((shift) => BASE64.charAt((chunk >> shift) & 63)).join('');
    // One byte gives two digits, two give three, three give four.
    text += digits.slice(0, Math.min(3, bytes.length - i) + 1);
  }
  return text.padEnd(Math.ceil(bytes.length / 3) * 4, '=');
}

/** Text as UTF-8 bytes (a lone surrogate as U+FFFD, as TextEncoder writes it). */
export function utf8Bytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const each of text) {
    let point = each.codePointAt(0) ?? 0;
    if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
    if (point < 0x80) bytes.push(point);
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 63));
    else if (point < 0x10000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 63),
        0x80 | ((point >> 6) & 63),
        0x80 | (point & 63),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/** The length of the sequence a lead byte starts; 0 for a byte no UTF-8 sequence starts with. */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead < 0xc2) return 0; // a continuation byte, or C0/C1, which only start overlong forms
  if (lead < 0xe0) return 2;
  if (lead < 0xf0) return 3;
  // F5 and up decode past U+10FFFF (F8 and up to an overlong form): `holds` refuses them.
  return 4;
}

/** The smallest point each length may hold: anything less is an overlong form. */
const SMALLEST = [0, 0, 0x80, 0x800, 0x10000] as const;

/** Whether a decoded point is one this length may hold: not overlong, not a surrogate, not past U+10FFFF. */
const holds = (point: number, length: number) =>
  point >= (SMALLEST[length] ?? 0) && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff);

/**
 * UTF-8 bytes as text (RFC 3629); refused when they are not UTF-8 — a
 * stray or missing continuation, an overlong form, an encoded surrogate or a
 * point past U+10FFFF — since a signed body that is not text is not Granola's.
 */
export function utf8Text(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length;) {
    const lead = bytes[i] ?? 0;
    const length = sequenceLength(lead);
    if (length === 0 || i + length > bytes.length) throw new WebhookRefusal('body: not UTF-8');
    let point = length === 1 ? lead : lead & (0xff >> (length + 1));
    for (let k = 1; k < length; k += 1) {
      const trail = bytes[i + k] ?? 0;
      if ((trail & 0xc0) !== 0x80) throw new WebhookRefusal('body: not UTF-8');
      point = (point << 6) | (trail & 63);
    }
    if (!holds(point, length)) throw new WebhookRefusal('body: not UTF-8');
    text += String.fromCodePoint(point);
    i += length;
  }
  return text;
}

/** Whether two strings are equal, in a time that does not tell how much of them matched. */
function sameText(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
}

/** The signing key: the secret's base64 after `whsec_`. */
function signingKey(secret: string): Uint8Array {
  const key = secret.startsWith('whsec_') ? base64Bytes(secret.slice('whsec_'.length)) : null;
  if (key === null || key.length === 0) {
    throw new WebhookRefusal('the webhook secret is not set (paste whsec_… from Granola)');
  }
  return key;
}

/** A header as n8n's Webhook node hands it over (names lower-case); null when absent. */
function header(headers: unknown, name: string): string | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const value: unknown = (headers as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

export interface WebhookDelivery {
  /** The request's headers, names in lower case. */
  readonly headers: unknown;
  /** The body exactly as sent: the signature is over its bytes, not over parsed JSON. */
  readonly body: Uint8Array;
}

export interface WebhookCheck {
  /** `whsec_` and the base64 key, as the sender shows it. */
  readonly secret: string;
  /** Now, in milliseconds since the epoch, from the caller's clock. */
  readonly now: number;
}

/** The webhook's timestamp, refused when it is not one or is more than the tolerance from now. */
function freshTimestamp(value: string | null, now: number): string {
  if (value === null || !/^\d{1,12}$/.test(value)) {
    throw new WebhookRefusal('webhook-timestamp: missing or not seconds since the epoch');
  }
  // A clock that is not a number would make every distance NaN, and no NaN is "too far".
  if (!Number.isFinite(now)) throw new WebhookRefusal('the clock is not a number; refusing');
  if (Math.abs(now / 1000 - Number(value)) > TIMESTAMP_TOLERANCE_SECONDS) {
    throw new WebhookRefusal('webhook-timestamp: more than five minutes from now');
  }
  return value;
}

/**
 * Checks a delivery's signature: HMAC-SHA256 of `{id}.{timestamp}.{body}`
 * under the secret's key, base64, matching one of the `v1,` signatures in
 * `webhook-signature` (space-separated, for key rotation). Returns the
 * webhook's id; throws {@link WebhookRefusal} for anything else.
 */
export function verifyStandardWebhook(delivery: WebhookDelivery, check: WebhookCheck): string {
  const key = signingKey(check.secret);
  const id = header(delivery.headers, 'webhook-id');
  if (id === null || id === '') throw new WebhookRefusal('webhook-id: missing');
  const timestamp = freshTimestamp(header(delivery.headers, 'webhook-timestamp'), check.now);
  const signed = utf8Bytes(`${id}.${timestamp}.`);
  const message = new Uint8Array(signed.length + delivery.body.length);
  message.set(signed);
  message.set(delivery.body, signed.length);
  const expected = base64Text(hmacSha256(key, message));
  const offered = (header(delivery.headers, 'webhook-signature') ?? '').split(' ');
  const matches = offered.filter((each) => each.startsWith('v1,'));
  if (!matches.some((each) => sameText(each.slice('v1,'.length), expected))) {
    throw new WebhookRefusal('webhook-signature: no v1 signature matches');
  }
  return id;
}
