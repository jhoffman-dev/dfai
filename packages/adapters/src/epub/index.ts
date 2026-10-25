/*
 * The EPUB reader's adapter (#505), an entry point of its own, as the PDF
 * reader's is: foliate-js and its zip reader are loaded only by the reader's
 * chunk, the first time a book opens, and by adding an EPUB.
 */
export { foliateEpubReader } from './foliate-reader.ts';
export { yieldToHost } from './yield-to-host.ts';
export type { FoliateBook, FoliateReader } from './foliate-reader.ts';
export type {
  ChapterAppearance,
  ChapterEvents,
  ChapterMark,
  ShownChapter,
} from './chapter-frame.ts';
