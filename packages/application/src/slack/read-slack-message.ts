import {
  readCapture,
  SlackMessageMissingError,
  slackCapturePayload,
  slackToPlain,
  THREAD_LIMIT,
  usersToLookUp,
  type Capture,
  type CaptureKind,
  type SlackPermalink,
} from '@dfai/domain';
import { SlackError, type SlackPort } from './ports.ts';

/** What a pasted link's message is, before it is saved: shown, then saved as a note or a task. */
export interface SlackMessagePreview {
  /** The capture/v1 payload, as `POST /v1/captures` would be sent it. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly author: string;
  /** The message's words, as plain text. */
  readonly text: string;
  readonly replies: number;
  readonly attachments: number;
}

/** How many people are looked up at once: users.info allows about 100 a minute. */
export const LOOKUPS_AT_ONCE = 4;

/**
 * Failures that end the read, even for one person's name: every other lookup
 * would fail alike — the token, the vault, the Keychain, the network, or a
 * missing `users:read` — so the first ends the read with its own message and
 * no more are asked. A refusal of one profile (`user_not_found`, a profile
 * hidden from the reader) writes that person by id; so does every lookup
 * after Slack asks DFAI to slow down, which stops asking rather than losing
 * the message.
 */
const ENDS_THE_READ = new Set([
  'no_token',
  'refused',
  'invalid',
  'keychain',
  'unreachable',
  'timeout',
  'missing_scope',
]);

/**
 * Each id's `users.info` answer, or null for one not read, at most
 * {@link LOOKUPS_AT_ONCE} out at a time, in the order asked.
 */
async function lookUpAll(
  read: (id: string) => Promise<unknown>,
  ids: readonly string[],
): Promise<unknown[]> {
  const answers: unknown[] = ids.map(() => null);
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (next < ids.length && !stopped) {
      const at = next;
      next += 1;
      try {
        answers[at] = await read(ids[at] as string);
      } catch (error) {
        const ends = !(error instanceof SlackError) || ENDS_THE_READ.has(error.failure.kind);
        if (ends || error.failure.kind === 'rate_limited') stopped = true;
        if (ends) throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUPS_AT_ONCE, ids.length) }, worker));
  return answers;
}

/** Whoever the token reads as, looked up first as n8n looks up whoever asked; null if Slack does not say. */
async function readerOf(slack: SlackPort, vault: string): Promise<string | null> {
  const answer = await slack.call({ vault, method: 'auth.test', query: {} });
  const id = (answer as Readonly<Record<string, unknown>> | null)?.['user_id'];
  return typeof id === 'string' ? id : null;
}

type Fields = Readonly<Record<string, unknown>>;
const fieldsOf = (value: unknown): Fields =>
  typeof value === 'object' && value !== null ? (value as Fields) : {};

/** One page of `conversations.replies`: its messages, and where the next starts (null on the last). */
function pageOf(answer: unknown): { messages: unknown[]; cursor: string | null } {
  const fields = fieldsOf(answer);
  const messages = Array.isArray(fields['messages']) ? fields['messages'] : [];
  const cursor = fieldsOf(fields['response_metadata'])['next_cursor'];
  const more = fields['has_more'] === true && typeof cursor === 'string' && cursor !== '';
  return { messages, cursor: more ? (cursor as string) : null };
}

/**
 * The thread `link` is in, as one `conversations.replies` answer: read a
 * page at a time until the linked message is among them, the thread ends,
 * or {@link THREAD_LIMIT} messages are read. A reply past the limit is a
 * {@link SlackError} saying so — it is there, only further than DFAI reads.
 * The first page is the one n8n reads, so a message on it is shaped alike.
 */
async function readThread({
  slack,
  vault,
  link,
}: {
  slack: SlackPort;
  vault: string;
  link: SlackPermalink;
}): Promise<Fields> {
  const messages: unknown[] = [];
  let cursor: string | null = null;
  const holdsLinked = () => messages.some((message) => fieldsOf(message)['ts'] === link.ts);
  do {
    const query: Record<string, string> = {
      channel: link.channel,
      ts: link.threadTs ?? link.ts,
      limit: String(THREAD_LIMIT - messages.length),
    };
    if (cursor !== null) query['cursor'] = cursor;
    const page = pageOf(await slack.call({ vault, method: 'conversations.replies', query }));
    messages.push(...page.messages.slice(0, THREAD_LIMIT - messages.length));
    cursor = page.cursor;
  } while (cursor !== null && !holdsLinked() && messages.length < THREAD_LIMIT);
  if (!holdsLinked() && cursor !== null) {
    throw new SlackError({ kind: 'past_thread_limit', message: String(THREAD_LIMIT) });
  }
  return { ok: true, messages };
}

/** The payload, the message being missing from Slack's answer read as Slack's not-found. */
function payloadOf(answers: Parameters<typeof slackCapturePayload>[0]) {
  try {
    return slackCapturePayload(answers);
  } catch (error) {
    if (!(error instanceof SlackMessageMissingError)) throw error;
    throw new SlackError({ kind: 'not_found', message: 'message_not_found' });
  }
}

/**
 * Reads the message a pasted Slack link names, with its thread and the
 * names of everyone in it, through the host (#105), and shapes it as the
 * capture/v1 payload n8n would send for it (ADR-0049) — the same shaping,
 * so either way in writes the same note. The payload is read by the contract
 * here, so a message it would refuse is refused before it is offered.
 * Throws a {@link SlackError} when Slack could not be asked or would not answer.
 */
export async function readSlackMessage({
  slack,
  vault,
  link,
  kind,
}: {
  slack: SlackPort;
  vault: string;
  link: SlackPermalink;
  kind: CaptureKind;
}): Promise<SlackMessagePreview> {
  const { channel, ts } = link;
  const reader = await readerOf(slack, vault);
  const replies = await readThread({ slack, vault, link });
  const permalink = await slack.call({
    vault,
    method: 'chat.getPermalink',
    query: { channel, message_ts: ts },
  });
  const readUser = (user: string) => slack.call({ vault, method: 'users.info', query: { user } });
  const users = await lookUpAll(readUser, usersToLookUp({ ts, replies, first: reader }));
  const payload = payloadOf({ message: { channel, ts, kind }, permalink, replies, users });
  return { payload, ...previewOf(readCapture(payload)) };
}

function previewOf(capture: Capture): Omit<SlackMessagePreview, 'payload'> {
  return {
    author: capture.message.author.name,
    text: slackToPlain(capture.message.text, capture.users),
    replies: capture.thread.length,
    attachments: capture.attachments.length,
  };
}
