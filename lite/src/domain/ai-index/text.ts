/** One generated file: where it goes in the vault, and its whole text. */
export interface IndexFile {
  readonly path: string;
  readonly text: string;
}

/** Where the generated files live. */
export const INDEX_ROOT = '_index';

/** The longest first sentence an index line carries, in characters. */
export const MAX_LINE_SUMMARY = 140;

/** Code-unit order: the same on every machine, whatever its locale. */
export const byCode = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** `text` cut to `max` characters, an ellipsis marking the cut. */
export function truncated(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Up to `max` items joined by spaces, then `+N` for the ones left out. */
export function cappedList(items: readonly string[], max: number): string {
  const shown = items.slice(0, max).join(' ');
  return items.length > max ? `${shown} +${items.length - max}` : shown;
}

/** A file's text from its lines: `\n` endings, one trailing newline. */
export function fileText(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

const encoder = new TextEncoder();

/** Size in UTF-8 bytes, as the file will be on disk. */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** A wiki link to a note by name. */
export const linkTo = (name: string): string => `[[${name}]]`;
