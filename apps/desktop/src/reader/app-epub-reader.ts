import { foliateEpubReader, type FoliateReader } from '@dfai/adapters/epub';

/*
 * The app's EPUB reader (#505): foliate-js, bundled with the app, reading
 * each book from its bytes, so opening one fetches nothing from anywhere.
 * Imported only by the book reader's chunk and by adding an EPUB, both
 * loaded on first use.
 */
export const appEpubReader: FoliateReader = foliateEpubReader();
