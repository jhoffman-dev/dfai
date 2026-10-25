/**
 * Characters no one can see in the name of an entry a caller asks DFAI to
 * write (P32-05): a name that hides text — `Board` followed by tag characters
 * spelling something, a joiner between letters — looks like one entry and is
 * another. Emoji keep the invisible characters they are built from: a joiner
 * between two emoji, and the tag run of a subdivision flag.
 */

/** Zero-width and bidirectional format characters, never part of an emoji. */
const FORMAT_CHARACTERS =
  /[\u00ad\u061c\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

const ZERO_WIDTH_JOINER = 0x200d;
const VARIATION_SELECTOR_16 = 0xfe0f;
const BLACK_FLAG = 0x1f3f4;
const TAG_FIRST = 0xe0000;
const TAG_LAST = 0xe007f;
const CANCEL_TAG = 0xe007f;

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_MODIFIER = /\p{Emoji_Modifier}/u;
/** Something that shows: not a space, a format or control character, nor a mark on nothing. */
const VISIBLE = /[^\p{White_Space}\p{Cf}\p{Cc}\p{Mn}\p{Me}]/u;

/**
 * Why a name sent from outside the app may not name an entry, or null: it
 * holds a character no one can see outside an emoji, or nothing that shows.
 */
export function hiddenCharacterProblem(name: string, noun: 'view' | 'dashboard'): string | null {
  if (name.trim() !== '' && !VISIBLE.test(name))
    return `A ${noun}’s name needs a character that shows.`;
  const points = Array.from(name, (character) => character.codePointAt(0) ?? 0);
  const hidden =
    FORMAT_CHARACTERS.test(name) ||
    points.some((point, at) => point === ZERO_WIDTH_JOINER && !joinsEmoji(points, at)) ||
    !tagsOnlyInFlags(points);
  return hidden ? `A ${noun}’s name cannot hold an invisible formatting character.` : null;
}

function isEmojiPoint(point: number | undefined): boolean {
  if (point === undefined) return false;
  const character = String.fromCodePoint(point);
  return PICTOGRAPHIC.test(character) || EMOJI_MODIFIER.test(character);
}

/** A joiner holds two emoji together: one before it (past a presentation selector), one after. */
function joinsEmoji(points: readonly number[], at: number): boolean {
  const before = points[at - 1] === VARIATION_SELECTOR_16 ? points[at - 2] : points[at - 1];
  return isEmojiPoint(before) && isEmojiPoint(points[at + 1]);
}

/** Tag characters only as a subdivision flag's run: the black flag, tags, then the cancel tag. */
function tagsOnlyInFlags(points: readonly number[]): boolean {
  for (let at = 0; at < points.length; at += 1) {
    if (!isTag(points[at])) continue;
    if (points[at - 1] !== BLACK_FLAG) return false;
    let end = at;
    while (end < points.length && isTag(points[end]) && points[end] !== CANCEL_TAG) end += 1;
    if (points[end] !== CANCEL_TAG || end === at) return false;
    at = end;
  }
  return true;
}

function isTag(point: number | undefined): boolean {
  return point !== undefined && point >= TAG_FIRST && point <= TAG_LAST;
}
