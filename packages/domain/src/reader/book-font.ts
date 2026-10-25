/*
 * The EPUB reader's text size (#505): a percentage of the book's own, in
 * steps a press of A− or A+ moves between, from small print to large.
 */

/** The sizes offered, smallest first; the book's own (100) among them. */
export const BOOK_FONT_SIZES: readonly number[] = [80, 90, 100, 110, 125, 150, 175, 200];

/** The book's own size, which a book opens at. */
export const BOOK_FONT_DEFAULT = 100;

/** The next size up from `size`, or the largest. */
export const largerBookFont = (size: number): number =>
  BOOK_FONT_SIZES.find((step) => step > size) ?? (BOOK_FONT_SIZES.at(-1) as number);

/** The next size down from `size`, or the smallest. */
export const smallerBookFont = (size: number): number =>
  [...BOOK_FONT_SIZES].reverse().find((step) => step < size) ?? (BOOK_FONT_SIZES[0] as number);

/** The size as the reader's bar says it. */
export const bookFontLabel = (size: number): string => `${Math.round(size)}%`;
