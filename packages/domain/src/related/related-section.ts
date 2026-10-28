import { foldedLinkName } from '../markdown/resolve-wikilink.ts';
import { openFenceClosing, scanMarkdown } from '../markdown/wikilink-spans.ts';

/**
 * Where an accepted related note's link is written (P32-03): a "Related"
 * section at the end of the note, one `- [[link]]` a line — the "see also"
 * of a Zettelkasten card. Only bytes are added; every byte already in the
 * body stays where it was (ADR-0003).
 */

/** The heading the accepted links are listed under. */
export const RELATED_HEADING = 'Related';

const RELATED_LINE = /^ {0,3}##[ \t]+related[ \t]*#*[ \t]*$/i;
/** A heading that ends the section: one of level one or two. */
const SECTION_END = /^ {0,3}#{1,2}(?:[ \t]|$)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])[ \t]/;

interface Line {
  readonly text: string;
  /** Where the line starts in the body. */
  readonly start: number;
  /** Where the line ends, past its line break if it has one. */
  readonly end: number;
  /**
   * In code or a comment, as the markdown scanner reads them — where a
   * `## Related` is code, not a heading.
   */
  readonly code: boolean;
}

/**
 * The body with `- [[target]]` added to its Related section: after the
 * section's last line when there is one, else under a new `## Related` at
 * the end. Null when the section already lists a link to `target`, however
 * it is spelled — the note is already linked, and nothing is written twice.
 * The lines added end with `eol` — by default the body's own line break
 * ({@link lineBreakOf}); a caller holding the whole file passes the file's, as
 * a body of one line has none to go by.
 *
 * Code and comments are read by the repo's own markdown scanner
 * (`scanMarkdown`), so this and every link reader agree on what is code. A
 * body left inside an open fenced block has it closed first, in the bytes
 * added: markdown reads such a block on to the end, so its contents read as
 * the same code, and the link after it reads as a link.
 */
export function withRelatedLink(
  body: string,
  target: string,
  eol: string = lineBreakOf(body),
): string | null {
  const item = `- [[${target}]]`;
  const scan = scanMarkdown(body);
  const lines = linesOf(body, [...scan.code, ...scan.comments]);
  const heading = lastRelatedHeading(lines);
  if (heading === -1) return withNewSection({ body, item, eol });

  const section = sectionAfter(lines, heading);
  const from = (lines[heading] as Line).start;
  const to = section.at(-1)?.end ?? (lines[heading] as Line).end;
  const wanted = foldedLinkName(target);
  const listed = scan.links.some(
    (span) => span.start >= from && span.start < to && foldedLinkName(span.link.target) === wanted,
  );
  if (listed) return null;
  // Never into a code block the section ends in, left open: added there it would be code.
  const openFrom = openFenceClosing(body) === null ? body.length : (scan.code.at(-1)?.start ?? 0);
  const last = [...section]
    .reverse()
    .find((line) => line.text.trim() !== '' && line.start < openFrom);
  const after = last ?? (lines[heading] as Line);
  const lineBreak = after.end === body.length && !endsWithBreak(body) ? eol : '';
  const gap = last === undefined || !LIST_ITEM.test(last.text) ? eol : '';
  return `${body.slice(0, after.end)}${lineBreak}${gap}${item}${eol}${body.slice(after.end)}`;
}

/** A new Related section at the end, after closing a fenced block the body leaves open. */
function withNewSection({ body, item, eol }: { body: string; item: string; eol: string }): string {
  const closing = openFenceClosing(body);
  const closed =
    closing === null ? body : `${body}${endsWithBreak(body) ? '' : eol}${closing}${eol}`;
  return `${closed}${newSection(closed, eol)}${item}${eol}`;
}

/** The line break a text is written with: CRLF where it has one, else LF. */
export function lineBreakOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** A new section's heading, after a blank line unless the body is empty. */
function newSection(body: string, eol: string): string {
  const breaks =
    body === '' || body.endsWith(`${eol}${eol}`) ? '' : endsWithBreak(body) ? eol : `${eol}${eol}`;
  return `${breaks}## ${RELATED_HEADING}${eol}${eol}`;
}

const endsWithBreak = (body: string): boolean => body.endsWith('\n');

function linesOf(body: string, code: readonly { start: number; end: number }[]): Line[] {
  const lines: Line[] = [];
  for (let start = 0; start < body.length;) {
    const breakAt = body.indexOf('\n', start);
    const end = breakAt === -1 ? body.length : breakAt + 1;
    const text = body.slice(start, end).replace(/\r?\n$/, '');
    const inCode = code.some((span) => start >= span.start && start < span.end);
    lines.push({ text, start, end, code: inCode });
    start = end;
  }
  return lines;
}

function lastRelatedHeading(lines: readonly Line[]): number {
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at] as Line;
    if (!line.code && RELATED_LINE.test(line.text)) return at;
  }
  return -1;
}

/** The lines under the heading at `heading`, up to the next heading of level one or two. */
function sectionAfter(lines: readonly Line[], heading: number): Line[] {
  const section: Line[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (!line.code && SECTION_END.test(line.text)) break;
    section.push(line);
  }
  return section;
}
