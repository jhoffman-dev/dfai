/**
 * An image's size on the page, as Obsidian writes it at the end of the alt
 * text: `![chart|400](chart.png)` is 400px wide, `![chart|400x300](chart.png)`
 * 400 by 300. Both are read; a resize writes the width alone (#568).
 */
export interface ImageSize {
  readonly width: number;
  readonly height: number | null;
}

/** The narrowest an image is drawn when it is resized by hand. */
export const MIN_IMAGE_WIDTH = 64;

const SIZE_AT_END = /^([\s\S]*)\|(\d{1,5})(?:x(\d{1,5}))?$/;

/** The alt text of `![alt](src)` split into the words and the size after its last `|`. */
export function readImageAlt(alt: string): { alt: string; size: ImageSize | null } {
  const found = SIZE_AT_END.exec(alt);
  const width = Number(found?.[2]);
  if (found === null || width <= 0) return { alt, size: null };
  const height = found[3] === undefined ? null : Number(found[3]);
  return { alt: found[1] ?? '', size: { width, height: height === 0 ? null : height } };
}

/** The alt text that says `alt` at `size`, as `readImageAlt` reads it back. */
export function writeImageAlt(alt: string, size: ImageSize | null): string {
  return size === null ? alt : `${alt}${sizeToken(size)}`;
}

function sizeToken({ width, height }: ImageSize): string {
  return height === null ? `|${width}` : `|${width}x${height}`;
}

/**
 * `markdown`, one image written `![alt](…)`, with only its size token changed
 * to `size` (none when null): every other byte stays as it was (ADR-0003).
 * Null when it is not an inline image whose alt text can be found.
 */
export function withImageSize(markdown: string, size: ImageSize | null): string | null {
  const close = altTextEnd(markdown);
  if (close === null || markdown[close + 1] !== '(') return null;
  const words = markdown.slice(2, close);
  const kept = readImageAlt(words).size === null ? words : words.replace(/\|[\dx]+$/, '');
  return `![${writeImageAlt(kept, size)}${markdown.slice(close)}`;
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
