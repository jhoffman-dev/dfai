import {
  utf8Text,
  verifyStandardWebhook,
  WebhookRefusal,
  type WebhookCheck,
  type WebhookDelivery,
} from './standard-webhook.ts';

/*
 * A Granola webhook (ADR-0034): signed by Standard Webhooks, carrying only
 * the note's id. Compiled into the workflow's "Verify Granola signature"
 * Code node (granola-code-node.ts); the note is fetched only after this.
 */

/** A Granola note id as the API writes it (`not_4kTq2mWxLp4Rz7`): it goes into the fetch's URL path. */
const NOTE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The note id a verified body names: `note_id` at the top or under `data`.
 * Granola's docs say only that the payload carries a `note_id`, not where,
 * so both are read (tools/n8n/README.md, "Granola webhooks → DFAI").
 */
export function webhookNoteId(body: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new WebhookRefusal('body: not JSON');
  }
  const data = isRecord(payload) ? payload['data'] : undefined;
  const id = isRecord(payload)
    ? (payload['note_id'] ?? (isRecord(data) ? data['note_id'] : null))
    : null;
  if (typeof id !== 'string' || !NOTE_ID.test(id)) {
    throw new WebhookRefusal('body: no note_id that is a Granola note id');
  }
  return id;
}

/**
 * The most a delivery's body may be, checked before it is hashed. Granola's
 * payload carries only a note id; anything near this is not Granola's.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** How much of an unreadable body the failure email quotes. */
const EXCERPT_BYTES = 200;

/**
 * A delivery Granola signed whose body cannot be read: it is answered 200
 * and emailed, never refused, since the sender is Granola (ADR-0034).
 */
export class UnreadableWebhookBody extends Error {
  override readonly name = 'UnreadableWebhookBody';
}

/** The body's first bytes, printable ASCII kept and every other byte as `\xNN`: safe in an email. */
export function bodyExcerpt(body: Uint8Array): string {
  let text = '';
  for (const byte of body.subarray(0, EXCERPT_BYTES)) {
    text +=
      byte >= 0x20 && byte < 0x7f
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return body.length > EXCERPT_BYTES ? `${text}…` : text;
}

/** What the verify node hands on: a refusal to answer 401, or the note to fetch. */
export type GranolaWebhookCheck =
  | { readonly signed: false; readonly reason: string }
  | { readonly signed: true; readonly webhookId: string; readonly noteId: string };

/** The delivery's signature, held to the size cap first: a refusal is an answer, not a failure. */
function signature(delivery: WebhookDelivery, check: WebhookCheck): GranolaWebhookCheck | string {
  try {
    if (delivery.body.length > MAX_BODY_BYTES) {
      throw new WebhookRefusal(`body: over ${MAX_BODY_BYTES} bytes`);
    }
    return verifyStandardWebhook(delivery, check);
  } catch (error) {
    if (error instanceof WebhookRefusal) return { signed: false, reason: error.message };
    throw error;
  }
}

/**
 * A delivery checked, then read: the body's note id is trusted only once its
 * signature is. A refusal comes back as `signed: false` (the workflow answers
 * it 401, in silence); a signed body that names no note throws
 * {@link UnreadableWebhookBody}; anything else that throws is a fault.
 */
export function verifyGranolaWebhook(
  delivery: WebhookDelivery,
  check: WebhookCheck,
): GranolaWebhookCheck {
  const webhookId = signature(delivery, check);
  if (typeof webhookId !== 'string') return webhookId;
  try {
    return { signed: true, webhookId, noteId: webhookNoteId(utf8Text(delivery.body)) };
  } catch (error) {
    if (!(error instanceof WebhookRefusal)) throw error;
    throw new UnreadableWebhookBody(
      `signed by Granola, but ${error.message}; it begins: ${bodyExcerpt(delivery.body)}`,
    );
  }
}
