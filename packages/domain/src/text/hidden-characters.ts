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
 * Characters drawn as nothing, which split a word without a reader seeing it:
 * every format character (`Cf`) and every default-ignorable code point, so the
 * soft hyphen, the zero-width spaces and joiners, the variation selectors,
 * the Mongolian and Khmer free variation marks, the hieroglyph and musical
 * format controls, the tags and the code points kept ignorable for later.
 * Taken by property, not listed, because a list misses one and a key split by
 * it is kept. Emoji are built of the zero-width joiner and selector 16, so an
 * Activity line loses their joins — a family drawn as its people — which is
 * the price of never keeping a split key. Text kept as a note keeps them.
 */
export const DRAWN_AS_NOTHING = '\\p{Cf}\\p{Default_Ignorable_Code_Point}';

/** Half of a surrogate pair with no other half: JSON can carry one, UTF-8 cannot write it. */
export const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
