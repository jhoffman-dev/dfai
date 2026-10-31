import type { CaptureKind } from '../mapping/capture-payload.ts';
import {
  fittedAttachments,
  fittedEmail,
  fittedName,
  fittedThread,
  holdsLink,
  type Attachment,
} from './slack-fit.ts';

/*
 * Slack's Web API answers as one capture/v1 payload (ADR-0049): the message,
 * the rest of its thread, its files as links (never downloaded), and the
 * names of everyone in it. Written for n8n (#104, PR #623) and moved here for
 * a pasted link (#105), so that both senders shape a message alike and the
 * contract's mapper writes it alike. Beside the mapping folder rather than
 * in it, and importing only from it, so n8n can compile it into its own Code
 * node without the contract's mapper carrying it.
 */

/** A Web API answer that is not `ok`: Slack answers 200 with `ok: false` and why. */
export class SlackApiError extends Error {
  override readonly name: string = 'SlackApiError';
}

/** The message is not among what Slack sent: deleted, or not the reader's to see. */
export class SlackMessageMissingError extends SlackApiError {
  override readonly name = 'SlackMessageMissingError';
}

/** The most people looked up for one capture; a mention past it is written by its id. */
export const MAX_LOOKUPS = 100;

/** The most messages one thread fetch asks for (Slack's own most); the rest are not saved. */
export const THREAD_LIMIT = 1000;

type Fields = Readonly<Record<string, unknown>>;
const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const field = (value: unknown, name: string): unknown =>
  isFields(value) ? value[name] : undefined;
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/** An answer's body, refused unless Slack said `ok`. */
function okAnswer(answer: unknown, method: string): Fields {
  if (!isFields(answer) || answer['ok'] !== true) {
    const why = text(field(answer, 'error')) ?? 'no answer it could read';
    throw new SlackApiError(`Slack's ${method} said ${why}`);
  }
  return answer;
}

const MENTION = /<@([UW][A-Z0-9]{8,20})(?:\|[^>]*)?>/g;
const USER_ID = /^[UW][A-Z0-9]{8,20}$/;

/** The thread's messages, as `conversations.replies` lists them (the parent first). */
export function threadMessages(replies: unknown): readonly Fields[] {
  const messages = okAnswer(replies, 'conversations.replies')['messages'];
  return Array.isArray(messages) ? messages.filter(isFields) : [];
}

/**
 * Whose names the capture needs: `first` (whoever asked, for n8n), the
 * saved message's author, then every other author and everyone mentioned,
 * at most {@link MAX_LOOKUPS}.
 */
export function usersToLookUp({
  ts,
  replies,
  first = null,
}: {
  /** The saved message's ts. */
  ts: string;
  replies: unknown;
  first?: string | null;
}): string[] {
  const messages = threadMessages(replies);
  const saved = messages.find((message) => message['ts'] === ts)?.['user'];
  // The saved message's author early: the cap must never leave out whose message it is.
  const ids = new Set<string>(first === null ? [] : [first]);
  if (typeof saved === 'string' && USER_ID.test(saved)) ids.add(saved);
  for (const message of messages) {
    const author = message['user'];
    if (typeof author === 'string' && USER_ID.test(author)) ids.add(author);
    for (const mention of String(message['text'] ?? '').matchAll(MENTION)) {
      if (mention[1] !== undefined) ids.add(mention[1]);
    }
  }
  return [...ids].slice(0, MAX_LOOKUPS);
}

interface Person {
  readonly name: string;
  readonly email: string | null;
}

/**
 * A `users.info` answer as a name and address, or null when it names nobody:
 * the display name, else the real name, else the handle, else the id, each
 * as the contract holds a name; an address it would refuse is left out.
 */
function personOf(answer: unknown): [string, Person] | null {
  const user = field(answer, 'user');
  const profile = field(user, 'profile');
  const id = text(field(user, 'id'));
  if (field(answer, 'ok') !== true || id === null) return null;
  const names = [
    field(profile, 'display_name'),
    field(profile, 'real_name'),
    field(user, 'real_name'),
    field(user, 'name'),
  ];
  return [id, { name: fittedName(names, id), email: fittedEmail(field(profile, 'email')) }];
}

/** A message's author: a person looked up, a bot by its name, or the id alone. */
function authorOf(message: Fields, people: ReadonlyMap<string, Person>) {
  const userId = text(message['user']);
  const person = userId === null ? undefined : people.get(userId);
  if (userId !== null)
    return { id: userId, name: person?.name ?? userId, email: person?.email ?? null };
  const botId = text(message['bot_id']);
  const name = fittedName([field(message['bot_profile'], 'name'), message['username']], 'a bot');
  return { id: botId, name, email: null };
}

/** Every file shared in the thread, by its permalink (a link for a person, never the file's bytes). */
function attachmentsOf(messages: readonly Fields[]): Attachment[] {
  const seen = new Set<string>();
  const all = messages.flatMap((message) => {
    const files = Array.isArray(message['files']) ? message['files'].filter(isFields) : [];
    return files.flatMap((file) => {
      const url = text(file['permalink']);
      if (url === null || !holdsLink(url) || seen.has(url)) return [];
      seen.add(url);
      return [{ name: fittedName([file['name'], file['title']], 'file'), url }];
    });
  });
  return fittedAttachments(all);
}

/** What the Slack API answered for one message, as a sender gathers it. */
export interface SlackAnswers {
  /** The message: its channel and ts, and whether it is saved as a note or a task. */
  readonly message: { readonly channel: string; readonly ts: string; readonly kind: CaptureKind };
  /** `chat.getPermalink`'s answer. */
  readonly permalink: unknown;
  /** `conversations.replies`' answer. */
  readonly replies: unknown;
  /** One `users.info` answer per id {@link usersToLookUp} named; one Slack refused may be null. */
  readonly users: readonly unknown[];
}

/**
 * The capture/v1 payload for the message. The thread is every other message
 * `conversations.replies` listed — the replies, or, for a reply saved by
 * itself, the parent and the other replies — and the mapper puts them in ts
 * order. Throws {@link SlackApiError} when Slack did not answer `ok`, and
 * {@link SlackMessageMissingError} when the message is not among what it sent.
 */
export function slackCapturePayload(answers: SlackAnswers) {
  const { message: target } = answers;
  const url = text(okAnswer(answers.permalink, 'chat.getPermalink')['permalink']);
  if (url === null) throw new SlackApiError("Slack's chat.getPermalink sent no permalink");
  const messages = threadMessages(answers.replies);
  const message = messages.find((each) => each['ts'] === target.ts);
  if (message === undefined) {
    throw new SlackMessageMissingError(
      'the message is not in the thread Slack sent (deleted, or not yours to see)',
    );
  }
  // A lookup Slack refused (a profile hidden from the reader, say) names that person by id instead.
  const people = new Map<string, Person>(
    answers.users.flatMap((answer) => {
      const person = personOf(answer);
      return person === null ? [] : [person];
    }),
  );
  const replies = messages
    .filter((each) => each !== message && typeof each['ts'] === 'string')
    .map((reply) => ({ reply, ts: String(reply['ts']), text: String(reply['text'] ?? '') }));
  const savedText = String(message['text'] ?? '');
  const thread = fittedThread(replies, { ts: target.ts, text: savedText });
  return {
    contract: 'capture/v1',
    kind: target.kind,
    source: {
      provider: 'slack',
      channel: { id: target.channel },
      ts: target.ts,
      url,
      author: authorOf(message, people),
    },
    text: savedText,
    thread: thread.map(({ reply, ts, text: words }) => ({
      ts,
      author: authorOf(reply, people),
      text: words,
    })),
    attachments: attachmentsOf([message, ...thread.map(({ reply }) => reply)]),
    users: Object.fromEntries([...people].map(([id, person]) => [id, person.name])),
  };
}
