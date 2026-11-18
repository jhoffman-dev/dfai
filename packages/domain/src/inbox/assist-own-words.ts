/**
 * The part of an Inbox item's text that is the person's own words (#909, rule
 * 6 of #899). Text that is only quoted or forwarded was written by someone
 * else, and a line Inbox assist applies is never justified by it alone: a
 * forwarded capture holding `From: Tobias Fenn <tobias@example.com>` does not
 * mean the person wants Tobias added.
 *
 * Not the person's own words, line by line:
 *
 * - a **quoted** line: one whose first character other than a space is `>`;
 * - a **quote's attribution**: `On … wrote:`, the line a mail client puts above one;
 * - a **header** line: `From:`, `To:`, `Cc:`, `Bcc:`, `Subject:`, `Sent:`,
 *   `Date:` or `Reply-To:` at the start, in any case;
 * - everything from the start of a **forwarded message** to the end of the
 *   text: from a separator line (`---------- Forwarded message ----------`,
 *   `-----Original Message-----`, `Begin forwarded message:`) or from the
 *   first `From:` header, whichever comes first.
 *
 * It errs toward leaving words out: a line of the person's own that happens
 * to start `Date:` only makes an item ask where it might not have.
 */

const QUOTED = /^\s*>/u;
const ATTRIBUTION = /^\s*on\s.+\swrote:\s*$/iu;
const HEADER = /^\s*(?:from|to|cc|bcc|subject|sent|date|reply-to)\s*:/iu;
const FORWARDED_FROM = /^\s*from\s*:/iu;
const FORWARD_SEPARATOR =
  /^\s*(?:-{2,}\s*(?:forwarded message|original message)\s*-{2,}|begin forwarded message:?)\s*$/iu;

/** `text` with every quoted, attribution, header and forwarded line left out, lines joined by `\n`. */
export function assistOwnWords(text: string): string {
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (FORWARD_SEPARATOR.test(line) || FORWARDED_FROM.test(line)) break;
    if (QUOTED.test(line) || ATTRIBUTION.test(line) || HEADER.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}
