import { hmacSha256 } from './sha256.ts';
import { utf8Bytes, WebhookRefusal } from './standard-webhook.ts';

/*
 * Slack's request signature (docs.slack.dev, "Verifying requests from
 * Slack"): `v0=` and the hex HMAC-SHA256 of `v0:<timestamp>:<body>` under
 * the app's signing secret. Plain JavaScript like sha256.ts, so the compiled
 * Code node runs on any engine: no Buffer, TextEncoder or crypto.
 */

/** How far a request's timestamp may be from now, either way, in seconds: Slack's five minutes. */
export const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** What the committed verify node holds instead of the signing secret, which James pastes in n8n only. */
export const SIGNING_SECRET_PLACEHOLDER = 'PASTE_THE_SLACK_SIGNING_SECRET_HERE';

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Whether two strings are equal, in a time that does not tell how much of them matched. */
function sameText(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
}

/** A header as n8n's Webhook node hands it over (names lower-case); null when absent. */
export function slackHeader(headers: unknown, name: string): string | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const value: unknown = (headers as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

export interface SlackDelivery {
  /** The request's headers, names in lower case. */
  readonly headers: unknown;
  /** The body exactly as sent: the signature is over its bytes, not over what n8n parsed. */
  readonly body: Uint8Array;
}

export interface SlackSignatureCheck {
  /** The app's signing secret (Basic Information → App Credentials), as Slack shows it. */
  readonly signingSecret: string;
  /** Now, in milliseconds since the epoch, from the caller's clock. */
  readonly now: number;
}

/** The secret as the key, refused while it is the placeholder or empty: nothing is signed by that. */
function signingKey(secret: string): Uint8Array {
  if (secret === '' || secret === SIGNING_SECRET_PLACEHOLDER) {
    throw new WebhookRefusal('the signing secret is not set (paste it from the Slack app)');
  }
  return utf8Bytes(secret);
}

/** The request's timestamp, refused when it is not one or is more than five minutes from now. */
function freshTimestamp(value: string | null, now: number): string {
  if (value === null || !/^\d{1,12}$/.test(value)) {
    throw new WebhookRefusal('x-slack-request-timestamp: missing or not seconds since the epoch');
  }
  // A clock that is not a number would make every distance NaN, and no NaN is "too far".
  if (!Number.isFinite(now)) throw new WebhookRefusal('the clock is not a number; refusing');
  if (Math.abs(now / 1000 - Number(value)) > SLACK_TIMESTAMP_TOLERANCE_SECONDS) {
    throw new WebhookRefusal('x-slack-request-timestamp: more than five minutes from now');
  }
  return value;
}

/** `v0=` and the hex signature Slack would send for this body at this timestamp. */
export function slackSignature(secret: Uint8Array, timestamp: string, body: Uint8Array): string {
  const signed = utf8Bytes(`v0:${timestamp}:`);
  const message = new Uint8Array(signed.length + body.length);
  message.set(signed);
  message.set(body, signed.length);
  return `v0=${hex(hmacSha256(secret, message))}`;
}

/**
 * Checks a request's `x-slack-signature` against its body and
 * `x-slack-request-timestamp`. Returns nothing; throws
 * {@link WebhookRefusal} when the request is not Slack's, now.
 */
export function verifySlackSignature(delivery: SlackDelivery, check: SlackSignatureCheck): void {
  const key = signingKey(check.signingSecret);
  const timestamp = freshTimestamp(
    slackHeader(delivery.headers, 'x-slack-request-timestamp'),
    check.now,
  );
  const offered = slackHeader(delivery.headers, 'x-slack-signature') ?? '';
  if (!sameText(offered, slackSignature(key, timestamp, delivery.body))) {
    throw new WebhookRefusal('x-slack-signature: does not match');
  }
}
