/**
 * An image's size on the page, as Obsidian writes it at the end of the alt
 * text: `![chart|400](chart.png)` is 400px wide, `![chart|400x300](chart.png)`
 * 400 by 300. Both are read; a resize writes the width alone (#568).
 *
 * A size is whole pixels written without a leading zero, and neither side is
 * zero: `|0400` and `|400x0` are words of the alt text, kept as written. A
 * pipe written `\|` is a word too, which is how alt text that only looks like
 * a size (`Route 66\|2024`) is kept as words. In a table cell `\|` is the
 * cell's own escape, so there the size's pipe is `\|` and a word pipe that
 * ends like a size is written `&#124;`, the one form a cell reads as a pipe.
 */
export interface ImageSize {
  readonly width: number;
  readonly height: number | null;
}

/** The narrowest an image is drawn when it is resized by hand. */
export const MIN_IMAGE_WIDTH = 64;

const SIDE = '[1-9]\\d{0,4}';
const SIZE_AT_END = new RegExp(`\\|(${SIDE})(?:x(${SIDE}))?$`);
/** A size token in markdown, with the backslashes before its pipe, which decide whether it is one. */
const TOKEN_AT_END = new RegExp(`(\\\\*)\\|(${SIDE})(?:x(${SIDE}))?$`);

/** The alt text of `![alt](src)`, as read, split into the words and the size after its last `|`. */
export function readImageAlt(alt: string): { alt: string; size: ImageSize | null } {
  const found = SIZE_AT_END.exec(alt);
  if (found === null) return { alt, size: null };
  return { alt: alt.slice(0, found.index), size: sizeOf(found[1], found[2]) };
}

/** The alt text that says `alt` at `size`, as `readImageAlt` reads it back. */
export function writeImageAlt(alt: string, size: ImageSize | null): string {
  return size === null ? alt : `${alt}${sizeToken(size)}`;
}

function sizeOf(width: string | undefined, height: string | undefined): ImageSize {
  return { width: Number(width), height: height === undefined ? null : Number(height) };
}

function sizeToken({ width, height }: ImageSize, pipe = '|'): string {
  return height === null ? `${pipe}${width}` : `${pipe}${width}x${height}`;
}

/** Where an image's markdown is: in a table cell a pipe is written `\|`, or it would end the cell. */
export interface ImagePlace {
  readonly inCell: boolean;
}

interface Token {
  /** Where the token starts in the words, its cell escape included. */
  readonly start: number;
  readonly size: ImageSize;
  /** The token as the alt text reads it: `|400`. */
  readonly reads: string;
}

/**
 * The size token at the end of an image's alt text as it is written. Its
 * pipe counts only when it is not escaped: after an even run of backslashes
 * outside a cell, after an odd run in one (the cell's own escape).
 */
function tokenAtEnd(words: string, { inCell }: ImagePlace): Token | null {
  const found = TOKEN_AT_END.exec(words);
  if (found === null) return null;
  const slashes = found[1]?.length ?? 0;
  if (slashes % 2 !== (inCell ? 1 : 0)) return null;
  const size = sizeOf(found[2], found[3]);
  return { start: found.index + slashes - (inCell ? 1 : 0), size, reads: sizeToken(size) };
}

/**
 * The words and size of an image, from its markdown and the alt text that
 * markdown was read as. Read from the markdown, so an escaped pipe, a pipe in
 * a code span or one written `&#124;` stays in the words.
 */
export function readImageMarkdown({
  markdown,
  alt,
  place,
}: {
  markdown: string;
  alt: string;
  place: ImagePlace;
}): { alt: string; size: ImageSize | null } {
  const close = altTextEnd(markdown);
  const token = close === null ? null : tokenAtEnd(markdown.slice(2, close), place);
  if (token === null || !alt.endsWith(token.reads)) return { alt, size: null };
  return { alt: alt.slice(0, alt.length - token.reads.length), size: token.size };
}

/**
 * `markdown`, one image written `![alt](…)`, with only its size token changed
 * to `size` (none when null): every other byte stays as it was (ADR-0003).
 * Null when it is not an inline image whose alt text can be found.
 */
export function withImageSize(
  markdown: string,
  size: ImageSize | null,
  place: ImagePlace,
): string | null {
  const close = altTextEnd(markdown);
  if (close === null || markdown[close + 1] !== '(') return null;
  const words = markdown.slice(2, close);
  const token = tokenAtEnd(words, place);
  const kept = token === null ? words : words.slice(0, token.start);
  return `![${sizedWords(kept, size, place)}${markdown.slice(close)}`;
}

/**
 * `markdown`, an image freshly written with `words` as its alt text, with
 * `size` added after them. Words that end like a size have that pipe escaped,
 * so they read back as words.
 */
export function withImageSizeAdded(
  markdown: string,
  size: ImageSize | null,
  place: ImagePlace,
): string {
  const close = altTextEnd(markdown);
  if (close === null) return markdown;
  return `![${sizedWords(markdown.slice(2, close), size, place)}${markdown.slice(close)}`;
}

/** How a pipe is written so it reads as a pipe: the size's, and a word's that would read as a size. */
const PIPES = {
  outside: { size: '|', word: '\\|' },
  // `\\|` in a cell would be a backslash and then the pipe that ends the cell.
  inCell: { size: '\\|', word: '&#124;' },
} as const;

function sizedWords(words: string, size: ImageSize | null, place: ImagePlace): string {
  const pipes = place.inCell ? PIPES.inCell : PIPES.outside;
  const looksSized = tokenAtEnd(words, place);
  const safe =
    looksSized === null
      ? words
      : `${words.slice(0, looksSized.start)}${pipes.word}${words.slice(looksSized.start + pipes.size.length)}`;
  return size === null ? safe : `${safe}${sizeToken(size, pipes.size)}`;
}

/** Where the `]` that closes an image's alt text is: brackets nest, and `\` escapes one. */
function altTextEnd(markdown: string): number | null {
  if (!markdown.startsWith('![')) return null;
  let depth = 0;
  for (let at = 2; at < markdown.length; at += 1) {
    const char = markdown[at];
    if (char === '\\') at += 1;
    else if (char === '[') depth += 1;
    else if (char === ']' && depth === 0) return at;
    else if (char === ']') depth -= 1;
  }
  return null;
}

/**
 * The width an image dragged to `width` is drawn at: whole pixels, no
 * narrower than `MIN_IMAGE_WIDTH` and no wider than the column it is in.
 */
export function resizedImageWidth({ width, column }: { width: number; column: number }): number {
  const widest = Math.max(MIN_IMAGE_WIDTH, Math.floor(column));
  return Math.min(widest, Math.max(MIN_IMAGE_WIDTH, Math.round(width)));
}
