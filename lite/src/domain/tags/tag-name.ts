/**
 * A tag's name is what follows its `#`: `idea`, `area/health`. Each `/` nests
 * it under the part before, and each part is a word of letters, digits, `_`
 * and `-`.
 */

const SEGMENT_START = /^[\p{L}\p{N}]$/u;
const SEGMENT_CHAR = /^[\p{L}\p{N}\p{M}_-]$/u;
const LETTER = /\p{L}/u;

/**
 * `_` may be inside a word of a tag (`#my_tag`) but may not end one: markdown
 * reads `_x_` as emphasis. A part's closing `_`s are not part of the tag.
 */
export const EDGE_UNDERSCORE = '_';

/** Whether `char` may open one part of a tag's name. */
export function startsTagSegment(char: string | undefined): boolean {
  return char !== undefined && SEGMENT_START.test(char);
}

/** Whether `char` may carry on one part of a tag's name. */
export function continuesTagSegment(char: string | undefined): boolean {
  return char !== undefined && SEGMENT_CHAR.test(char);
}

/** A number alone is not a tag — `#123` is an issue, `#2026` a year — so a name holds a letter. */
export function hasTagLetter(name: string): boolean {
  return LETTER.test(name);
}

/**
 * What makes two tags the same tag: case is ignored, as are the ways one
 * letter can be encoded. `#Idea` and `#idea` are one tag.
 */
export function tagKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Whether `key` is `ancestor` or nested somewhere under it. Both are keys. */
export function isTagWithin(key: string, ancestor: string): boolean {
  return key === ancestor || key.startsWith(`${ancestor}/`);
}
