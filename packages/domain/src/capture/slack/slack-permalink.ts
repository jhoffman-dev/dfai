import { MAX_URL_LENGTH, PERMALINK, TS } from '../mapping/capture-payload.ts';

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

/**
 * Text that is a Slack message link and nothing else, read by the rule the
 * contract checks a capture's `source.url` with (ADR-0049), so a link read
 * here is one a capture holds. Null for anything else — a link among other
 * words, a channel's link, another site's.
 */
export function readSlackPermalink(text: string): SlackPermalink | null {
  const url = text.trim();
  if (url.length > MAX_URL_LENGTH) return null;
  const parts = PERMALINK.exec(url);
  const [, channel, digits] = parts ?? [];
  if (channel === undefined || digits === undefined) return null;
  const ts = `${digits.slice(0, 10)}.${digits.slice(10)}`;
  const threadTs = THREAD_TS.exec(url)?.[1] ?? null;
  return { url, channel, ts, threadTs: threadTs !== null && TS.test(threadTs) ? threadTs : null };
}
