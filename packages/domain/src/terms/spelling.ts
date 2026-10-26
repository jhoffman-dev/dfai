/**
 * Characters that take no room and mean nothing in a spelling — the
 * zero-width space, the word joiner and the byte-order mark, which text
 * copied from a chat or a web page often carries, and the direction marks,
 * embeddings, overrides and isolates (U+200E, U+200F, U+202A–U+202E,
 * U+2066–U+2069) a subject in Hebrew or Arabic often carries. Invisible in
 * a box, they are dropped. The zero-width joiner and
 * non-joiner are kept: they shape Persian and Indic words and join emoji into one.
 */
const NO_ROOM = /[\u200B\u2060\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** The joiners kept within a spelling, which are still nothing on their own. */
const ONLY_JOINERS = /^[\u200C\u200D\s]*$/u;

/**
 * A spelling composed one way and spaced with single spaces, its case kept —
 * or nothing, when nothing in it can be seen.
 */
export function tidySpelling(form: string): string {
  const tidied = form.normalize('NFC').replace(NO_ROOM, '').replace(/\s+/gu, ' ').trim();
  return ONLY_JOINERS.test(tidied) ? '' : tidied;
}

/**
 * What makes two spellings the same one: composed the same way, spaced with
 * single spaces, and lower-cased — so `Lark  Spur` and `lark spur` are one.
 */
export function vocabularyKey(form: string): string {
  return tidySpelling(form).toLowerCase();
}

/** A letter, a digit, a combining mark or `_`: what a word is made of. */
export const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;

/**
 * Whether a misheard spelling can be looked for in prose: it has a letter or
 * a digit in it, since `~` or `--` would be found in every timestamp and
 * rule, and it holds no NUL, which correction writes over the text it must
 * not touch.
 */
export function isSearchable(form: string): boolean {
  return WORD_CHARACTER.test(form) && !form.includes('\u0000');
}
