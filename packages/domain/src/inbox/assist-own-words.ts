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
 * - a **quote's attribution**: `On … wrote:`, the line a mail client puts above
 *   one, wrapped onto as many as {@link ATTRIBUTION_LINES} lines (#911): from a
 *   line opening `On ` to the first that ends `wrote:`, or that ends `:` with
 *   only quoted lines, or nothing, after it;
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

/** The most lines a mail client wraps a quote's attribution onto. */
export const ATTRIBUTION_LINES = 4;
const OPENER = /^\s*on\s\S/iu;
const WROTE = /\bwrote:\s*$/iu;
const ENDS_COLON = /:\s*$/u;

/** `text` with every quoted, attribution, header and forwarded line left out, lines joined by `\n`. */
export function assistOwnWords(text: string): string {
  const lines = text.split(/\r?\n/u);
  const attribution = attributionLines(lines);
  const kept: string[] = [];
  for (const [at, line] of lines.entries()) {
    if (FORWARD_SEPARATOR.test(line) || FORWARDED_FROM.test(line)) break;
    if (attribution.has(at) || QUOTED.test(line) || ATTRIBUTION.test(line) || HEADER.test(line))
      continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/** The lines of every quote attribution, wrapped or not: each from its `On …` to where it ends. */
function attributionLines(lines: readonly string[]): ReadonlySet<number> {
  const marked = new Set<number>();
  for (const [at, line] of lines.entries()) {
    if (!OPENER.test(line)) continue;
    const last = Math.min(lines.length, at + ATTRIBUTION_LINES);
    for (let end = at; end < last; end += 1) {
      if (!endsAttribution(lines, end)) continue;
      for (let each = at; each <= end; each += 1) marked.add(each);
      break;
    }
  }
  return marked;
}

/** Whether line `at` ends an attribution: `wrote:`, or `:` with only quoted lines, or nothing, after it. */
function endsAttribution(lines: readonly string[], at: number): boolean {
  const line = lines[at]!;
  if (WROTE.test(line)) return true;
  if (!ENDS_COLON.test(line)) return false;
  const after = lines.slice(at + 1).filter((each) => each.trim() !== '');
  return after.every((each) => QUOTED.test(each));
}
