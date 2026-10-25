import {
  bookStyles,
  STYLE_LIMITS,
  styleBudget,
  type StyleBudget,
  type StyleLimits,
} from './book-styles.ts';
import { bookDeclarations } from './chapter-styles.ts';
import type { BookArchive } from './zip-loader.ts';

/*
 * A book's own files, as a chapter's frame is given them (#505, ADR-0045):
 * each picture and font a `data:` address of its bytes, read from the book,
 * and each stylesheet its CSS with every reference made one of those. A
 * `data:` document is opaque wherever it is opened, so a picture of the book
 * that holds a script can never run it as the app — a `blob:` of the app's
 * origin could. Each is read once per open book and kept: a stylesheet most
 * chapters share is made once, not once a chapter.
 */

export interface BookFiles {
  /** The book's file at `path` as a `data:` address, or null when the book has no such file. */
  address(path: string): Promise<string | null>;
  /** The book's stylesheet at `path`, its references made the book's own or nothing, within its chapter's `budget`; empty when there is none. */
  stylesheet(path: string, budget?: StyleBudget): Promise<string>;
  /** `css`, a `<style>` written in the book's file at `from`, made the same way, within its chapter's `budget`. */
  css(css: string, from: string, budget?: StyleBudget): Promise<string>;
  /** `style`, a `style=` written in the book's file at `from`, made the same way, within its chapter's `budget`. */
  declarations(style: string, from: string, budget?: StyleBudget): Promise<string>;
  /** A budget for one chapter's CSS, made fresh each time the chapter is. */
  budget(): StyleBudget;
}

export function bookFiles(
  archive: Pick<BookArchive, 'loadText' | 'loadBlob'>,
  limits: StyleLimits = STYLE_LIMITS,
): BookFiles {
  const addresses = new Map<string, Promise<string | null>>();
  const address = (path: string) =>
    held(addresses, path, async () => {
      const blob = await archive.loadBlob(path, mediaTypeOf(path));
      return blob === null ? null : dataAddress(blob);
    });
  // Each stylesheet is read and made once, whether a chapter links it or a sheet imports it.
  const styles = bookStyles({ address, stylesheet: (path) => archive.loadText(path), limits });
  return {
    address,
    css: (css, from, budget) => styles.css(css, from, budget),
    declarations: (style, from, budget) =>
      bookDeclarations({ style, from, address, limits, budget }),
    budget: () => styleBudget(limits),
    // Only the made sheets are kept: putting their imports in costs no more than joining them.
    stylesheet: (path, budget) => styles.sheet(path, budget),
  };
}

/** What `make` answers for `key`, made once; one that failed is made again the next time it is asked for. */
function held<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  const found = cache.get(key);
  if (found !== undefined) return found;
  const made = make();
  cache.set(key, made);
  made.catch(() => cache.delete(key));
  return made;
}

function dataAddress(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.readAsDataURL(blob);
  });
}

/** A file's type by its name: an SVG picture is drawn only when its address says it is one. */
export function mediaTypeOf(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return MEDIA_TYPES[extension] ?? 'application/octet-stream';
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  css: 'text/css',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};
