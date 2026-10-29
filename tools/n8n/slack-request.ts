import { utf8Text, WebhookRefusal } from './standard-webhook.ts';
import {
  verifySlackSignature,
  type SlackDelivery,
  type SlackSignatureCheck,
} from './slack-signature.ts';

/*
 * What Slack asked, once its signature holds (#104): a message shortcut
 * ("Save to DFAI as a note / task"), an emoji reaction on a message, or the
 * Events API's URL check. Compiled into the workflow's "Verify Slack
 * signature" Code node (slack-code-node.ts); nothing is fetched before this.
 */

/** The shortcuts' callback ids, as the Slack app's manifest declares them. */
export const SHORTCUT_CALLBACKS = { note: 'dfai_save_note', task: 'dfai_save_task' } as const;

/** What the committed verify node holds instead of James's member id, which he pastes in n8n. */
export const OWNER_PLACEHOLDER = 'U_PASTE_YOUR_SLACK_MEMBER_ID';

export type SlackCaptureKind = 'note' | 'task';

export interface SlackCaptureSettings {
  /** Whose shortcuts and reactions save: James's member id. Anyone else's are ignored. */
  readonly ownerUserId: string;
  /** The reaction names (no colons) that save a message as a note, and as a task. */
  readonly emoji: { readonly note: readonly string[]; readonly task: readonly string[] };
}

/** The emoji the committed workflow saves with: `:inbox_tray:` a note, `:ballot_box_with_check:` a task. */
export const DEFAULT_EMOJI: SlackCaptureSettings['emoji'] = {
  note: ['inbox_tray'],
  task: ['ballot_box_with_check'],
};

/** The message to save: where it is, as what, and who asked. */
export interface SlackCaptureAction {
  readonly action: 'capture';
  readonly via: 'shortcut' | 'reaction';
  readonly kind: SlackCaptureKind;
  readonly channel: string;
  readonly ts: string;
  readonly userId: string;
}

/** What a signed request asks: a message to save, the URL check, or nothing for us. */
export type SlackAction =
  | SlackCaptureAction
  | { readonly action: 'challenge'; readonly challenge: string }
  | { readonly action: 'ignore'; readonly reason: string };

/** What the verify node hands on; each is answered by its own Respond node. */
export type SlackCheck =
  { readonly signed: false; readonly reason: string } | ({ readonly signed: true } & SlackAction);

/**
 * A request Slack signed that cannot be read, or a workflow not set up: it is
 * answered 200 and emailed, never refused, since the sender is Slack.
 */
export class UnreadableSlackRequest extends Error {
  override readonly name = 'UnreadableSlackRequest';
}

/** The most a request's body may be, checked before it is hashed: Slack's are a few kB. */
export const MAX_SLACK_BODY_BYTES = 256 * 1024;

const CHANNEL_ID = /^[CDG][A-Z0-9]{8,20}$/;
const USER_ID = /^[UW][A-Z0-9]{8,20}$/;
const TS = /^\d{10}\.\d{6}$/;

type Fields = Readonly<Record<string, unknown>>;
const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const field = (value: unknown, name: string): unknown =>
  isFields(value) ? value[name] : undefined;

/** A field that must be a string matching `pattern`; refused, naming it, otherwise. */
function idField(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new WebhookRefusal(`${name}: missing or not a Slack id`);
  }
  return value;
}

/** A form body's `payload` field (a shortcut is `payload=<JSON>`, form-encoded). */
function formPayload(body: string): string {
  const pair = body.split('&').find((each) => each.startsWith('payload='));
  if (pair === undefined) throw new WebhookRefusal('body: a form with no payload');
  try {
    return decodeURIComponent(pair.slice('payload='.length).replace(/\+/g, ' '));
  } catch {
    throw new WebhookRefusal('body: payload is not form-encoded');
  }
}

/** The body as JSON: an Events API body as it is, a shortcut's from its form field. */
function bodyJson(body: string): unknown {
  const text = body.trimStart().startsWith('{') ? body : formPayload(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new WebhookRefusal('body: not JSON');
  }
}

/** A message shortcut: the callback id says note or task. */
function shortcutAction(payload: Fields, settings: SlackCaptureSettings): SlackAction {
  const callback = payload['callback_id'];
  const kind =
    callback === SHORTCUT_CALLBACKS.note
      ? 'note'
      : callback === SHORTCUT_CALLBACKS.task
        ? 'task'
        : null;
  if (kind === null) return { action: 'ignore', reason: 'another shortcut' };
  const userId = idField(field(payload['user'], 'id'), 'user.id', USER_ID);
  if (userId !== settings.ownerUserId) return { action: 'ignore', reason: 'not your shortcut' };
  return {
    action: 'capture',
    via: 'shortcut',
    kind,
    channel: idField(field(payload['channel'], 'id'), 'channel.id', CHANNEL_ID),
    ts: idField(payload['message_ts'] ?? field(payload['message'], 'ts'), 'message_ts', TS),
    userId,
  };
}

/** The kind a reaction saves as; a skin tone (`::skin-tone-2`) is the same emoji. */
function reactionKind(reaction: unknown, settings: SlackCaptureSettings): SlackCaptureKind | null {
  if (typeof reaction !== 'string') return null;
  const name = reaction.split('::')[0] ?? '';
  if (settings.emoji.note.includes(name)) return 'note';
  if (settings.emoji.task.includes(name)) return 'task';
  return null;
}

/** An Events API callback: only James's saving reactions on a message are captures. */
function eventAction(payload: Fields, settings: SlackCaptureSettings): SlackAction {
  const event = payload['event'];
  if (field(event, 'type') !== 'reaction_added')
    return { action: 'ignore', reason: 'another event' };
  const kind = reactionKind(field(event, 'reaction'), settings);
  if (kind === null) return { action: 'ignore', reason: 'another emoji' };
  const userId = idField(field(event, 'user'), 'event.user', USER_ID);
  if (userId !== settings.ownerUserId) return { action: 'ignore', reason: 'not your reaction' };
  const item = field(event, 'item');
  if (field(item, 'type') !== 'message') return { action: 'ignore', reason: 'not on a message' };
  return {
    action: 'capture',
    via: 'reaction',
    kind,
    channel: idField(field(item, 'channel'), 'event.item.channel', CHANNEL_ID),
    ts: idField(field(item, 'ts'), 'event.item.ts', TS),
    userId,
  };
}

/** What a signed body asks. Throws {@link WebhookRefusal} when it cannot be read. */
export function slackAction(body: string, settings: SlackCaptureSettings): SlackAction {
  const payload = bodyJson(body);
  if (!isFields(payload)) throw new WebhookRefusal('body: not a JSON object');
  const type = payload['type'];
  if (type === 'url_verification') {
    const challenge = payload['challenge'];
    if (typeof challenge !== 'string') throw new WebhookRefusal('challenge: missing');
    return { action: 'challenge', challenge };
  }
  if (type === 'message_action') return shortcutAction(payload, settings);
  if (type === 'event_callback') return eventAction(payload, settings);
  return { action: 'ignore', reason: 'another kind of request' };
}

/** How much of an unreadable body the failure email quotes. */
const EXCERPT_BYTES = 200;

/** The body's first bytes, printable ASCII kept and every other byte as `\xNN`: safe in an email. */
export function slackBodyExcerpt(body: Uint8Array): string {
  let text = '';
  for (const byte of body.subarray(0, EXCERPT_BYTES)) {
    text +=
      byte >= 0x20 && byte < 0x7f
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return body.length > EXCERPT_BYTES ? `${text}…` : text;
}

/** The signature, held to the size cap first: a refusal is an answer (401), not a failure. */
function signatureRefusal(delivery: SlackDelivery, check: SlackSignatureCheck): string | null {
  try {
    if (delivery.body.length > MAX_SLACK_BODY_BYTES) {
      throw new WebhookRefusal(`body: over ${MAX_SLACK_BODY_BYTES} bytes`);
    }
    verifySlackSignature(delivery, check);
    return null;
  } catch (error) {
    if (error instanceof WebhookRefusal) return error.message;
    throw error;
  }
}

/** The settings, refused as unreadable while the member id is still the placeholder. */
function checkedSettings(settings: SlackCaptureSettings): SlackCaptureSettings {
  if (!USER_ID.test(settings.ownerUserId)) {
    throw new UnreadableSlackRequest(
      'OWNER is not set: paste your Slack member id into "Verify Slack signature"',
    );
  }
  return settings;
}

/**
 * A request checked, then read: its body is trusted only once its signature
 * is. A refusal comes back as `signed: false` (answered 401, in silence); a
 * signed body that cannot be read, or a workflow whose OWNER is not set,
 * throws {@link UnreadableSlackRequest} (answered 200 and emailed).
 */
export function verifySlackRequest(
  delivery: SlackDelivery,
  check: SlackSignatureCheck & { readonly settings: SlackCaptureSettings },
): SlackCheck {
  const reason = signatureRefusal(delivery, check);
  if (reason !== null) return { signed: false, reason };
  const settings = checkedSettings(check.settings);
  try {
    return { signed: true, ...slackAction(utf8Text(delivery.body), settings) };
  } catch (error) {
    if (!(error instanceof WebhookRefusal)) throw error;
    throw new UnreadableSlackRequest(
      `signed by Slack, but ${error.message}; it begins: ${slackBodyExcerpt(delivery.body)}`,
    );
  }
}
