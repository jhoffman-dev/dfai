/**
 * A note split into its YAML frontmatter and its body.
 *
 * `frontmatter` holds the whole leading block including both `---` delimiters and
 * the newline after the closing one, so `frontmatter + body` is always exactly the
 * original file. Keeping it as opaque text means the editor cannot damage it;
 * parsing it into typed properties waits for Phase 5.
 */
export interface MarkdownDocument {
  readonly frontmatter: string | null;
  readonly body: string;
  /** Where the body starts in the original text — the base for block source ranges. */
  readonly bodyOffset: number;
}

/**
 * A line consisting of exactly `---`, optionally with trailing spaces, then a
 * line end — after a byte-order mark, when the file has one, which is kept
 * with the frontmatter so the split stays lossless.
 */
const OPENING = /^\uFEFF?---[ \t]*\r?\n/;
const CLOSING = /^---[ \t]*(\r?\n|$)/;

/**
 * Frontmatter must open on the very first byte: a `---` anywhere else is a
 * horizontal rule. An unterminated block is not frontmatter either, which matches
 * how Obsidian reads the same file.
 */
export function splitFrontmatter(text: string): MarkdownDocument {
  const opening = OPENING.exec(text);
  if (opening === null) return { frontmatter: null, body: text, bodyOffset: 0 };

  let cursor = opening[0].length;
  while (cursor < text.length) {
    const lineEnd = text.indexOf('\n', cursor);
    const line = text.slice(cursor, lineEnd === -1 ? text.length : lineEnd + 1);
    if (CLOSING.test(line)) {
      const bodyOffset = lineEnd === -1 ? text.length : lineEnd + 1;
      return {
        frontmatter: text.slice(0, bodyOffset),
        body: text.slice(bodyOffset),
        bodyOffset,
      };
    }
    if (lineEnd === -1) break;
    cursor = lineEnd + 1;
  }

  return { frontmatter: null, body: text, bodyOffset: 0 };
}

/**
 * Whether the text opens a frontmatter block on its first byte and never
 * closes it: read as all body, which is right for a note and wrong for a file
 * whose settings are its frontmatter.
 */
export function opensUnclosedFrontmatter(text: string): boolean {
  return OPENING.test(text) && splitFrontmatter(text).frontmatter === null;
}

const BLANK_BLOCK = /^\uFEFF?---[ \t]*\r?\n(?:[ \t]*\r?\n)*---[ \t]*(?:\r?\n)?$/;

/** Whether a frontmatter block holds nothing at all — no keys, no comments — between its delimiters. */
export function isBlankFrontmatter(frontmatter: string): boolean {
  return BLANK_BLOCK.test(frontmatter);
}

/** The inverse of {@link splitFrontmatter}, byte for byte. */
export function joinDocument(document: MarkdownDocument): string {
  return (document.frontmatter ?? '') + document.body;
}

/**
 * A note's text from its frontmatter and a new body, such that it splits back
 * into exactly those two.
 *
 * Frontmatter can close on the file's last byte, and a body glued onto that
 * `---` would leave the block unclosed and every property lost, so the body is
 * put on its own line. With no frontmatter, a body that would itself read as
 * frontmatter is pushed down a line so it stays body. Otherwise every byte is
 * kept, so an untouched note is written back as it was.
 */
export function joinFrontmatter(frontmatter: string | null, body: string): string {
  if (frontmatter === null) {
    return splitFrontmatter(body).frontmatter === null ? body : `\n${body}`;
  }
  const endsItsLine = frontmatter.endsWith('\n') || body === '';
  return endsItsLine ? frontmatter + body : `${frontmatter}\n${body}`;
}

/** Replaces the body while leaving the frontmatter exactly as it was. */
export function withBody(document: MarkdownDocument, body: string): MarkdownDocument {
  return { ...document, body };
}

/**
 * A body with more markdown added at its end, as a block of its own.
 *
 * Every line up to the last one with anything on it keeps its bytes; the
 * addition follows exactly one blank line, so it can never run on into the
 * paragraph before it, and ends with a newline as a file should.
 */
export function appendToBody(body: string, addition: string): string {
  const lines = body.split('\n');
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
  const ending = addition.endsWith('\n') ? addition : `${addition}\n`;
  return lines.length === 0 ? ending : `${lines.join('\n')}\n\n${ending}`;
}
