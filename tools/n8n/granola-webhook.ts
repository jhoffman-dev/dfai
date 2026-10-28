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

/** What the verify node hands on to the fetch. */
export interface VerifiedGranolaWebhook {
  readonly webhookId: string;
  readonly noteId: string;
}

/** A delivery checked, then read: the body's note id is trusted only once its signature is. */
export function verifyGranolaWebhook(
  delivery: WebhookDelivery,
  check: WebhookCheck,
): VerifiedGranolaWebhook {
  const webhookId = verifyStandardWebhook(delivery, check);
  return { webhookId, noteId: webhookNoteId(utf8Text(delivery.body)) };
}
