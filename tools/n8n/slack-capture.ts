import type { SlackCaptureAction } from './slack-request.ts';

/*
 * Slack's Web API answers as one capture/v1 payload (ADR-0049, #104): the
 * message the shortcut or reaction was on, the rest of its thread, its files
 * as links (never downloaded), and the names of everyone in it. Compiled
 * into the workflow's Code nodes; the app's own mapper reads the result.
 */

/** A Web API answer that is not `ok`: Slack answers 200 with `ok: false` and why. */
export class SlackApiError extends Error {
  override readonly name = 'SlackApiError';
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
 * Whose names the capture needs: whoever asked (always one, so n8n's lookup
 * runs at least once), every author and everyone mentioned, at most
 * {@link MAX_LOOKUPS}.
 */
export function usersToLookUp(action: SlackCaptureAction, replies: unknown): string[] {
  const ids = new Set<string>([action.userId]);
  for (const message of threadMessages(replies)) {
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

const isOk = (answer: unknown) => isFields(answer) && answer['ok'] === true;

/** A `users.info` answer as a name and address: the display name, else the real name. */
function personOf(answer: unknown): [string, Person] {
  const user = okAnswer(answer, 'users.info')['user'];
  const profile = field(user, 'profile');
  const id = text(field(user, 'id'));
  if (id === null) throw new SlackApiError("Slack's users.info said nothing of whose it was");
  const name =
    text(field(profile, 'display_name')) ??
    text(field(profile, 'real_name')) ??
    text(field(user, 'real_name')) ??
    text(field(user, 'name')) ??
    id;
  return [id, { name: name.trim(), email: text(field(profile, 'email')) }];
}

/** A message's author: a person looked up, a bot by its name, or the id alone. */
function authorOf(message: Fields, people: ReadonlyMap<string, Person>) {
  const userId = text(message['user']);
  const person = userId === null ? undefined : people.get(userId);
  if (userId !== null)
    return { id: userId, name: person?.name ?? userId, email: person?.email ?? null };
  const botId = text(message['bot_id']);
  const name = text(field(message['bot_profile'], 'name')) ?? text(message['username']) ?? 'a bot';
  return { id: botId, name, email: null };
}

/** Every file shared in the thread, by its permalink (a link for a person, never the file's bytes). */
function attachmentsOf(messages: readonly Fields[]) {
  const seen = new Set<string>();
  return messages.flatMap((message) => {
    const files = Array.isArray(message['files']) ? message['files'].filter(isFields) : [];
    return files.flatMap((file) => {
      const url = text(file['permalink']);
      if (url === null || !url.startsWith('https://') || seen.has(url)) return [];
      seen.add(url);
      return [{ name: text(file['name']) ?? text(file['title']) ?? 'file', url }];
    });
  });
}

/** What the Slack API answered for one capture, as the build node gathers it. */
export interface SlackAnswers {
  readonly action: SlackCaptureAction;
  /** `chat.getPermalink`'s answer. */
  readonly permalink: unknown;
  /** `conversations.replies`' answer. */
  readonly replies: unknown;
  /** One `users.info` answer per id {@link usersToLookUp} named. */
  readonly users: readonly unknown[];
}

/**
 * The capture/v1 payload for the message the action was on. The thread is
 * every other message `conversations.replies` listed — the replies, or, for
 * a reply saved by itself, the parent and the other replies — and the
 * mapper puts them in ts order. Throws {@link SlackApiError} when Slack did
 * not answer `ok`, or the message is not among what it sent.
 */
export function slackCapturePayload(answers: SlackAnswers) {
  const { action } = answers;
  const url = text(okAnswer(answers.permalink, 'chat.getPermalink')['permalink']);
  if (url === null) throw new SlackApiError("Slack's chat.getPermalink sent no permalink");
  const messages = threadMessages(answers.replies);
  const message = messages.find((each) => each['ts'] === action.ts);
  if (message === undefined) {
    throw new SlackApiError(
      'the message is not in the thread Slack sent (deleted, or not yours to see)',
    );
  }
  // A lookup Slack refused (a profile hidden from James, say) names that person by id instead.
  const people = new Map(answers.users.filter(isOk).map(personOf));
  const others = messages.filter((each) => each !== message && typeof each['ts'] === 'string');
  return {
    contract: 'capture/v1',
    kind: action.kind,
    source: {
      provider: 'slack',
      channel: { id: action.channel },
      ts: action.ts,
      url,
      author: authorOf(message, people),
    },
    text: String(message['text'] ?? ''),
    thread: others.map((reply) => ({
      ts: reply['ts'],
      author: authorOf(reply, people),
      text: String(reply['text'] ?? ''),
    })),
    attachments: attachmentsOf([message, ...others]),
    users: Object.fromEntries([...people].map(([id, person]) => [id, person.name])),
  };
}
