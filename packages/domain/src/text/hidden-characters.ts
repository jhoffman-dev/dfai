/*
 * The characters a reader cannot see, in one place, so the text DFAI takes in
 * (capture) and the text it keeps (the Activity log) never disagree on them.
 * Each list is the body of a character class, for a `u` regular expression.
 */

/** The marks that turn text right to left or back: they disguise a link or a file name as another. */
export const DIRECTION_MARKS = '\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069';

/** The byte-order mark, which JavaScript's `\s` reads as a space. */
export const BYTE_ORDER_MARK = '\\uFEFF';

/**
 * Characters drawn as nothing, which split a word without a reader seeing
 * it: the soft hyphen, the grapheme joiner, the Hangul fillers, the Mongolian
 * vowel separator, the zero-width spaces and joiners, the invisible operators,
 * the deprecated format marks, the variation selectors and the tags. Text kept
 * as a note keeps them, since emoji are built of joiners and selectors.
 */
export const DRAWN_AS_NOTHING =
  '\\u00AD\\u034F\\u115F\\u1160\\u180E\\u200B-\\u200D\\u2060-\\u2065\\u206A-\\u206F\\u3164\\uFE00-\\uFE0F\\uFFA0\\u{E0000}-\\u{E007F}';

/** Half of a surrogate pair with no other half: JSON can carry one, UTF-8 cannot write it. */
export const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
