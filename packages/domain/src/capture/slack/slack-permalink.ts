import { CHANNEL_ID, MAX_URL_LENGTH, PERMALINK, TS } from '../mapping/capture-payload.ts';

/** A Slack message link, read: the message it names, and its thread's when it is a reply. */
export interface SlackPermalink {
  /** The link as given, trimmed. */
  readonly url: string;
  readonly channel: string;
  /** The message's ts, with its dot back: `1793136000.000100`. */
  readonly ts: string;
  /** The thread's first message, when the link is to a reply (`?thread_ts=…`); else null. */
  readonly threadTs: string | null;
}

const THREAD_TS = /[?&]thread_ts=(\d{10}\.\d{6})(?:&|$)/;

/** A scheme and host, in any case, as a browser may write them. */
const ORIGIN = /^https:\/\/[^/]+/i;

/**
 * The link as the contract's PERMALINK reads one: the host in lower case,
 * and no fragment or trailing slash, which a browser or Slack's own "Copy
 * link" may add and which name the same message.
 */
function canonical(url: string): string {
  const withoutFragment = url.replace(/#.*$/, '');
  const [path = '', query] = withoutFragment.split('?', 2);
  const tidied = path.replace(/\/$/, '').replace(ORIGIN, (origin) => origin.toLowerCase());
  return query === undefined ? tidied : `${tidied}?${query}`;
}

/**
 * Text that is a Slack message link and nothing else, read by the rules the
 * contract checks a capture's `source.url` and channel with (ADR-0049), so a
 * link read here is one a capture holds. Null for anything else — a link
 * among other words, a channel's link, another site's. The web client's
 * address (`app.slack.com/client/…`) is left out on purpose: it is the page
 * a browser shows, which names a team and a view as well as a message and
 * changes as Slack changes its client, where "Copy link" always gives the
 * `archives` permalink.
 */
export function readSlackPermalink(text: string): SlackPermalink | null {
  const url = text.trim();
  if (url.length > MAX_URL_LENGTH) return null;
  const read = canonical(url);
  const parts = PERMALINK.exec(read);
  const [, channel, digits] = parts ?? [];
  if (channel === undefined || digits === undefined || !CHANNEL_ID.test(channel)) return null;
  const ts = `${digits.slice(0, 10)}.${digits.slice(10)}`;
  const threadTs = THREAD_TS.exec(read)?.[1] ?? null;
  return { url, channel, ts, threadTs: threadTs !== null && TS.test(threadTs) ? threadTs : null };
}
