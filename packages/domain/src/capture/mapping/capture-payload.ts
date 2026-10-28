import { Reasons, shownValue } from './capture-refusal.ts';
import { cleanText, oneLineText } from './capture-text.ts';

/*
 * The capture contract, capture/v1 (ADR-0049): what a sender — n8n from
 * Slack (#104), DFAI itself from a pasted link (#105), Claude through
 * `atlas_capture` (#106) — hands DFAI to save one message, and its thread,
 * as an Inbox note or task. Read here, refused with every reason when it is
 * wrong, before anything is written.
 */

/** The contract's name and version, sent as `contract` and written as `atlas_import`. */
export const CAPTURE_V1 = 'capture/v1';

/** The one provider capture/v1 reads; another is a v1 refusal, not a guess. */
export const SLACK_PROVIDER = 'slack';

export type CaptureKind = 'note' | 'task';

/** Who wrote a message, as Slack names them. */
export interface CaptureAuthor {
  /** Their Slack user id (`U…`, `W…`, or `B…` for a bot), or null when not sent. */
  readonly id: string | null;
  readonly name: string;
  /** Their address, what finds their Person note; null when not sent. */
  readonly email: string | null;
}

/** One message: the one captured, or a reply in its thread. */
export interface CaptureMessage {
  /** Slack's `ts`: seconds since the epoch, a dot, six digits. Unique within its channel. */
  readonly ts: string;
  readonly author: CaptureAuthor;
  /** As Slack sent it, in mrkdwn, cleaned of control characters. */
  readonly text: string;
  /** Its permalink; always there for the captured message, optional for a reply. */
  readonly url: string | null;
}

/** A file shared with the message, kept as a link: never downloaded. */
export interface CaptureAttachment {
  readonly name: string;
  readonly url: string;
}

/** A capture/v1 payload, read and checked. */
export interface Capture {
  readonly kind: CaptureKind;
  /** The title asked for, or null to take it from the message. */
  readonly title: string | null;
  readonly provider: typeof SLACK_PROVIDER;
  readonly channel: { readonly id: string; readonly name: string | null };
  readonly message: CaptureMessage & { readonly url: string };
  /** The replies, oldest first, the captured message itself left out. */
  readonly thread: readonly CaptureMessage[];
  readonly attachments: readonly CaptureAttachment[];
  readonly users: Readonly<Record<string, string>>;
  /** `<channel id>/<ts>`: what makes a second capture of the message the same one. */
  readonly externalId: string;
}

/** Slack allows 40,000 characters in a message; a longer one did not come from Slack. */
export const MAX_MESSAGE_LENGTH = 40_000;
export const MAX_REPLIES = 1_000;
export const MAX_ATTACHMENTS = 100;
export const MAX_USERS = 2_000;
/** All the text a capture may carry: the local API's whole request is held to 1 MiB too. */
export const MAX_TOTAL_LENGTH = 1_000_000;
const MAX_NAME_LENGTH = 200;
const MAX_TITLE_LENGTH = 500;
const MAX_URL_LENGTH = 2_000;

const CHANNEL_ID = /^[CDG][A-Z0-9]{8,20}$/;
const USER_ID = /^[UWB][A-Z0-9]{8,20}$/;
const TS = /^\d{10}\.\d{6}$/;
/**
 * A Slack permalink: `https://<team>.slack.com/archives/<channel>/p<ts without its dot>`,
 * with a query of the characters Slack writes in one (`?thread_ts=…&cid=…`) and no others:
 * the link is written into the note, where a bracket would make a wiki link of it.
 */
const PERMALINK =
  /^https:\/\/(?:[a-z0-9-]+\.)*slack\.com\/archives\/([A-Z0-9]+)\/p(\d{16})(?:\?[A-Za-z0-9._~%&=+-]*)?$/;
/** An https address with none of the characters markdown or a wiki link reads in one. */
const WEB_ADDRESS = /^https:\/\/[^\s/<>[\]!"'`\\]+(?:\/[^\s<>[\]!"'`\\]*)?$/;
/** An address, with nothing a link, a wiki link or HTML could be made of. */
const EMAIL = /^[^\s@<>[\]()"'`\\]+@[^\s@<>[\]()"'`\\]+$/;

const PAYLOAD_KEYS = [
  'contract',
  'kind',
  'title',
  'source',
  'text',
  'thread',
  'attachments',
  'users',
];
const SOURCE_KEYS = ['provider', 'channel', 'ts', 'url', 'author'];
const CHANNEL_KEYS = ['id', 'name'];
const AUTHOR_KEYS = ['id', 'name', 'email'];
const REPLY_KEYS = ['ts', 'author', 'text', 'url'];
const ATTACHMENT_KEYS = ['name', 'url'];

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A payload as capture/v1: every field checked, every problem named. Throws
 * a `CaptureRefusedError` listing them all. A null optional field is taken
 * as left out (n8n sends null for a value it has none of); a field the
 * contract does not have is refused, so a misspelt one cannot drop content.
 */
export function readCapture(payload: unknown): Capture {
  const reasons = new Reasons();
  if (!isFields(payload)) {
    reasons.add('capture', `expected an object, got ${shownValue(payload)}`);
    reasons.refuseIfAny();
  }
  const body = record(payload, 'capture', PAYLOAD_KEYS, reasons);
  if (body.contract !== CAPTURE_V1) {
    reasons.add('contract', `${shownValue(body.contract)} is not ${JSON.stringify(CAPTURE_V1)}`);
  }
  const kind = body.kind === 'note' || body.kind === 'task' ? body.kind : null;
  if (kind === null) reasons.add('kind', `${shownValue(body.kind)} is not "note" or "task"`);
  const source = record(body.source, 'source', SOURCE_KEYS, reasons);
  if (source.provider !== SLACK_PROVIDER) {
    reasons.add(
      'source.provider',
      `${shownValue(source.provider)} is not "slack", the one v1 reads`,
    );
  }
  const channel = channelOf(source.channel, reasons);
  const message = messageOf({ fields: source, text: body.text, field: 'source', reasons });
  const link = { url: source.url, field: 'source.url', channel, ts: message.ts, reasons };
  const url = permalinkOf(link);
  if (url === null) reasons.add('source.url', 'missing: the message’s permalink');
  const capture = {
    kind: kind ?? 'note',
    title: titleOf(body.title, reasons),
    provider: SLACK_PROVIDER,
    channel,
    message: { ...message, url: url ?? '' },
    thread: threadOf({ value: body.thread, channel, ts: message.ts, reasons }),
    attachments: attachmentsOf(body.attachments, reasons),
    users: usersOf(body.users, reasons),
    externalId: `${channel.id}/${message.ts}`,
  } satisfies Capture;
  checkSize(capture, reasons);
  reasons.refuseIfAny();
  return capture;
}

/** A record's fields, refusing any key it does not have; nothing for one that is not a record. */
function record(value: unknown, field: string, keys: readonly string[], reasons: Reasons): Fields {
  if (!isFields(value)) {
    reasons.add(field, `expected an object, got ${shownValue(value)}`);
    return {};
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) reasons.add(field, `${JSON.stringify(key)} is not one of its fields`);
  }
  return Object.fromEntries(Object.entries(value).filter(([, each]) => each !== null));
}

/** Text the sender must give: a string, with something in it once cleaned. */
function requiredLine(value: unknown, limit: Limit): string {
  if (value === undefined) {
    limit.reasons.add(limit.field, 'missing');
    return '';
  }
  const text = optionalLine(value, limit);
  if (text === null && typeof value === 'string') limit.reasons.add(limit.field, 'is blank');
  return text ?? '';
}

interface Limit {
  readonly field: string;
  readonly max: number;
  readonly reasons: Reasons;
}

/** Text the sender may give, as one line; null when left out or blank. */
function optionalLine(value: unknown, { field, max, reasons }: Limit): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    reasons.add(field, `expected text, got ${shownValue(value)}`);
    return null;
  }
  const line = oneLineText(value);
  if ([...line].length > max) reasons.add(field, `is longer than ${max} characters`);
  return line === '' ? null : line;
}

function matching(value: string, pattern: RegExp, { field, reasons }: Omit<Limit, 'max'>): string {
  if (value !== '' && !pattern.test(value))
    reasons.add(field, `${shownValue(value)} is not well formed`);
  return value;
}

function titleOf(value: unknown, reasons: Reasons): string | null {
  return optionalLine(value, { field: 'title', max: MAX_TITLE_LENGTH, reasons });
}

function channelOf(value: unknown, reasons: Reasons): Capture['channel'] {
  const fields = record(value, 'source.channel', CHANNEL_KEYS, reasons);
  const limit = { field: 'source.channel.id', max: 40, reasons };
  const id = matching(requiredLine(fields.id, limit), CHANNEL_ID, limit);
  const name = optionalLine(fields.name, { field: 'source.channel.name', max: 80, reasons });
  return { id, name: name?.replace(/^#/, '') || null };
}

function authorOf(value: unknown, field: string, reasons: Reasons): CaptureAuthor {
  const fields = record(value, field, AUTHOR_KEYS, reasons);
  const idLimit = { field: `${field}.id`, max: 40, reasons };
  const id = optionalLine(fields.id, idLimit);
  if (id !== null) matching(id, USER_ID, idLimit);
  const name = requiredLine(fields.name, { field: `${field}.name`, max: MAX_NAME_LENGTH, reasons });
  const email = optionalLine(fields.email, { field: `${field}.email`, max: 254, reasons });
  if (email !== null && !EMAIL.test(email)) {
    reasons.add(`${field}.email`, `${shownValue(email)} is not an address`);
  }
  return { id, name, email };
}

/** A message's ts, author and text, read from `fields` (the captured one's text is beside them). */
function messageOf({
  fields,
  text,
  field,
  reasons,
}: {
  fields: Fields;
  text: unknown;
  field: string;
  reasons: Reasons;
}): Omit<CaptureMessage, 'url'> {
  const tsLimit = { field: `${field}.ts`, max: 17, reasons };
  const ts = matching(requiredLine(fields.ts, tsLimit), TS, tsLimit);
  const author = authorOf(fields.author, `${field}.author`, reasons);
  const textField = field === 'source' ? 'text' : `${field}.text`;
  return { ts, author, text: messageText(text, textField, reasons) };
}

function messageText(value: unknown, field: string, reasons: Reasons): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    reasons.add(field, `expected text, got ${shownValue(value)}`);
    return '';
  }
  if (value.length > MAX_MESSAGE_LENGTH) {
    reasons.add(field, `is longer than ${MAX_MESSAGE_LENGTH} characters, Slack's own limit`);
  }
  return cleanText(value);
}

/**
 * A permalink to the message: Slack's own form, in its channel, at its ts.
 * The key is the channel and the ts, never the link, which Slack writes
 * with a workspace's or an organisation's domain and query parameters.
 */
function permalinkOf({
  url,
  field,
  channel,
  ts,
  reasons,
}: {
  url: unknown;
  field: string;
  channel: Capture['channel'];
  ts: string;
  reasons: Reasons;
}): string | null {
  const link = optionalLine(url, { field, max: MAX_URL_LENGTH, reasons });
  if (link === null) return null;
  const parts = PERMALINK.exec(link);
  if (parts === null) {
    reasons.add(
      field,
      `${shownValue(link)} is not a Slack permalink (https://….slack.com/archives/…)`,
    );
  } else if (parts[1] !== channel.id || parts[2] !== ts.replace('.', '')) {
    reasons.add(field, 'is not a link to this message: its channel or ts differ');
  }
  return link;
}

function threadOf({
  value,
  channel,
  ts,
  reasons,
}: {
  value: unknown;
  channel: Capture['channel'];
  ts: string;
  reasons: Reasons;
}): CaptureMessage[] {
  const replies = listOf(value, { field: 'thread', max: MAX_REPLIES, reasons }).map((each, at) => {
    const field = `thread[${at}]`;
    const fields = record(each, field, REPLY_KEYS, reasons);
    const reply = messageOf({ fields, text: fields.text, field, reasons });
    return {
      ...reply,
      url: permalinkOf({ url: fields.url, field: `${field}.url`, channel, ts: reply.ts, reasons }),
    };
  });
  // Slack's conversations.replies lists the parent first: it is the message, not a reply.
  const own = replies.filter((reply) => reply.ts !== ts);
  const seen = new Set<string>();
  for (const reply of own) {
    if (seen.has(reply.ts)) reasons.add('thread', `holds ${reply.ts} twice`);
    seen.add(reply.ts);
  }
  return own.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

function listOf(value: unknown, { field, max, reasons }: Limit): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    reasons.add(field, `expected a list, got ${shownValue(value)}`);
    return [];
  }
  if (value.length > max) reasons.add(field, `holds more than ${max}`);
  return value.slice(0, max);
}

function attachmentsOf(value: unknown, reasons: Reasons): CaptureAttachment[] {
  return listOf(value, { field: 'attachments', max: MAX_ATTACHMENTS, reasons }).map((each, at) => {
    const field = `attachments[${at}]`;
    const fields = record(each, field, ATTACHMENT_KEYS, reasons);
    const name = requiredLine(fields.name, {
      field: `${field}.name`,
      max: MAX_NAME_LENGTH,
      reasons,
    });
    const urlLimit = { field: `${field}.url`, max: MAX_URL_LENGTH, reasons };
    const url = requiredLine(fields.url, urlLimit);
    if (url !== '' && !WEB_ADDRESS.test(url))
      reasons.add(urlLimit.field, `${shownValue(url)} is not an https:// link`);
    return { name, url };
  });
}

function usersOf(value: unknown, reasons: Reasons): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!isFields(value)) {
    reasons.add('users', `expected an object of names by user id, got ${shownValue(value)}`);
    return {};
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_USERS) reasons.add('users', `names more than ${MAX_USERS}`);
  const users: Record<string, string> = {};
  for (const [id, name] of entries.slice(0, MAX_USERS)) {
    const field = `users[${JSON.stringify(id)}]`;
    if (!USER_ID.test(id)) reasons.add(field, 'is not a Slack user id');
    else users[id] = requiredLine(name, { field, max: MAX_NAME_LENGTH, reasons });
  }
  return users;
}

function checkSize(capture: Capture, reasons: Reasons): void {
  const total = [capture.message, ...capture.thread].reduce(
    (sum, each) => sum + each.text.length,
    0,
  );
  if (total > MAX_TOTAL_LENGTH)
    reasons.add('thread', `the messages hold more than ${MAX_TOTAL_LENGTH} characters`);
  if (capture.message.text.trim() === '' && capture.attachments.length === 0) {
    reasons.add('text', 'is empty, and there is no attachment to save instead');
  }
}
