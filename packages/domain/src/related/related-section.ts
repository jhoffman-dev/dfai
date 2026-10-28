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
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])[ \t]/;

interface Line {
  readonly text: string;
  /** Where the line starts in the body. */
  readonly start: number;
  /** Where the line ends, past its line break if it has one. */
  readonly end: number;
  /** Inside a fenced code block, where a `## Related` is code, not a heading. */
  readonly fenced: boolean;
  /** A fenced code block is still open after it: a line added here would be code. */
  readonly openAfter: boolean;
}

/**
 * The body with `- [[target]]` added to its Related section: after the
 * section's last line when there is one, else under a new `## Related` at
 * the end. Null when the section already lists a link to `target` — the
 * note is already linked, and nothing is written twice. The lines added end
 * with `eol` — by default the body's own line break ({@link lineBreakOf}); a
 * caller holding the whole file passes the file's, as a body of one line has
 * none to go by.
 */
export function withRelatedLink(
  body: string,
  target: string,
  eol: string = lineBreakOf(body),
): string | null {
  const item = `- [[${target}]]`;
  const lines = linesOf(body);
  const heading = lastRelatedHeading(lines);
  if (heading === -1) return `${body}${newSection(body, eol)}${item}${eol}`;

  const section = sectionAfter(lines, heading);
  if (section.some((line) => !line.fenced && listsLinkTo(line.text, target))) return null;
  // Never into a code block the section ends in, left open: added there it would be code.
  const last = [...section].reverse().find((line) => line.text.trim() !== '' && !line.openAfter);
  const after = last ?? (lines[heading] as Line);
  const lineBreak = after.end === body.length && !endsWithBreak(body) ? eol : '';
  const gap = last === undefined || !LIST_ITEM.test(last.text) ? eol : '';
  return `${body.slice(0, after.end)}${lineBreak}${gap}${item}${eol}${body.slice(after.end)}`;
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

function linesOf(body: string): Line[] {
  const lines: Line[] = [];
  let fence: string | null = null;
  for (let start = 0; start < body.length;) {
    const breakAt = body.indexOf('\n', start);
    const end = breakAt === -1 ? body.length : breakAt + 1;
    const text = body.slice(start, end).replace(/\r?\n$/, '');
    const marker = FENCE.exec(text)?.[1] ?? null;
    const opens = fence === null && marker !== null;
    const closes =
      fence !== null && marker !== null && marker[0] === fence[0] && marker.length >= fence.length;
    const fenced = fence !== null || opens;
    if (opens) fence = marker;
    else if (closes) fence = null;
    lines.push({ text, start, end, fenced, openAfter: fence !== null });
    start = end;
  }
  return lines;
}

function lastRelatedHeading(lines: readonly Line[]): number {
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at] as Line;
    if (!line.fenced && RELATED_LINE.test(line.text)) return at;
  }
  return -1;
}

/** The lines under the heading at `heading`, up to the next heading of level one or two. */
function sectionAfter(lines: readonly Line[], heading: number): Line[] {
  const section: Line[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (!line.fenced && SECTION_END.test(line.text)) break;
    section.push(line);
  }
  return section;
}

/** Whether a line links to `target`, as `[[target]]`, `[[target|shown]]` or `[[target#part]]`. */
function listsLinkTo(text: string, target: string): boolean {
  const wanted = target.trim().toLowerCase();
  for (const match of text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    if ((match[1] as string).trim().toLowerCase() === wanted) return true;
  }
  return false;
}
