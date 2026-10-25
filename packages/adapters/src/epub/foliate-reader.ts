import { EPUB, type EpubMetadata, type LanguageMap, type TocItem } from 'foliate-js/epub.js';
import { fromRange, joinIndir } from 'foliate-js/epubcfi.js';
import {
  epubProtection,
  type BookRange,
  type CfiPlace,
  type ContentsEntry,
  type EpubEncryption,
  type PdfMetadata,
} from '@dfai/domain';
import {
  EpubProtectedError,
  EpubUnreadableError,
  type EpubBook,
  type EpubReaderPort,
} from '@dfai/application';
import { openArchive, type BookArchive } from './zip-loader.ts';
import { chapterText, type ChapterText } from './chapter-text.ts';
import { offsetAt, rangeAt } from './text-positions.ts';
import { makeChapterSafe } from './chapter-safety.ts';
import {
  documentElementOf,
  getElementsByTagName,
  getElementsByTagNameNS,
} from './unshadowed-dom.ts';
import { bookFiles } from './book-files.ts';
import { chapterSource } from './chapter-source.ts';
import { recentCache } from './recent-cache.ts';
import {
  showChapter,
  type ChapterAppearance,
  type ChapterEvents,
  type ShownChapter,
} from './chapter-frame.ts';

/*
 * foliate-js behind the EPUB reader's port (#505). foliate-js reads the
 * book's package — its spine, contents, metadata — and its CFIs; this
 * translates: chapters into texts (`chapterText`), a CFI into a place in one
 * and back, its failures into `EpubUnreadableError`. A book locked with DRM
 * is refused before it is parsed (`epubProtection`). Nothing is fetched:
 * every book is opened from its bytes.
 *
 * A long book is not held whole: each chapter's text is kept once it has
 * been read (find and re-anchoring read them all), but only the few
 * chapters parsed last are kept as documents (`PARSED_CHAPTERS`); another is
 * parsed again when it is shown or a CFI in it is read.
 */

/** How many parsed chapters an open book keeps: the one on screen, the one before, and one a highlight named. */
const PARSED_CHAPTERS = 3;

/** An open EPUB that can also show its chapters. */
export interface FoliateBook extends EpubBook {
  /** The chapter (from 0) the book's file at `path` is, or null when it is no chapter of the spine. */
  sectionOfPath(path: string): number | null;
  /** Shows chapter `section` in a new frame inside `host`. */
  show(args: {
    section: number;
    host: HTMLElement;
    appearance: ChapterAppearance;
    events: ChapterEvents;
  }): Promise<ShownChapter>;
}

export interface FoliateReader extends EpubReaderPort {
  open(bytes: Uint8Array): Promise<FoliateBook>;
}

export function foliateEpubReader(): FoliateReader {
  return {
    async open(bytes) {
      let archive: BookArchive;
      try {
        archive = await openArchive(bytes);
      } catch (error) {
        // A bomb is refused by name; anything else zip.js could not read is no ZIP at all.
        if (error instanceof EpubUnreadableError) throw error;
        throw new EpubUnreadableError(`it is not a ZIP archive (${messageOf(error)})`);
      }
      if (epubProtection(await protectionOf(archive)).kind === 'protected') {
        throw new EpubProtectedError();
      }
      let book: EPUB;
      try {
        book = await new EPUB(archive).init();
      } catch (error) {
        throw new EpubUnreadableError(messageOf(error));
      }
      if (book.sections.length === 0) throw new EpubUnreadableError('it has no chapters');
      return openedBook(book, archive);
    },
  };
}

const ENCRYPTION_NS = 'http://www.w3.org/2001/04/xmlenc#';

/** What the archive says about encryption, for `epubProtection` to judge. */
async function protectionOf(
  archive: BookArchive,
): Promise<{ encrypted: EpubEncryption[]; entries: readonly string[] }> {
  const xml = await archive.loadText('META-INF/encryption.xml');
  if (xml === null) return { encrypted: [], entries: archive.entries };
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const encrypted = Array.from(
    getElementsByTagNameNS(doc, ENCRYPTION_NS, 'EncryptedData'),
    (data) => ({
      algorithm:
        data
          .getElementsByTagNameNS(ENCRYPTION_NS, 'EncryptionMethod')[0]
          ?.getAttribute('Algorithm') ?? null,
      uri:
        data.getElementsByTagNameNS(ENCRYPTION_NS, 'CipherReference')[0]?.getAttribute('URI') ??
        null,
    }),
  );
  // An encryption file that cannot be read says nothing is in the clear: taken as locked.
  const unreadable = getElementsByTagName(doc, 'parsererror').length > 0;
  return {
    encrypted: unreadable ? [{ algorithm: null, uri: null }] : encrypted,
    entries: archive.entries,
  };
}

/** A chapter parsed and made safe, and its text. */
interface Chapter {
  readonly doc: Document;
  readonly text: ChapterText;
}

function openedBook(book: EPUB, archive: BookArchive): FoliateBook {
  const sections = book.sections;
  const parsed = recentCache<number, Promise<Chapter>>(PARSED_CHAPTERS);
  const texts = new Map<number, string>();
  const files = bookFiles(archive);
  const chapter = (section: number): Promise<Chapter> => {
    const held = parsed.get(section);
    if (held !== undefined) return held;
    const reading = readChapter(archive, sectionAt(sections, section).id);
    parsed.set(section, reading);
    reading.then(
      ({ text }) => void texts.set(section, text.text),
      // A chapter that failed to read is read again the next time it is asked for.
      () => parsed.delete(section),
    );
    return reading;
  };
  return {
    sectionCount: sections.length,
    metadata: metadataOf(book.metadata),
    contents: contentsOf(book, book.toc ?? []),
    sectionText: async (section) => texts.get(section) ?? (await chapter(section)).text.text,
    async placeOfCfi(cfi) {
      const { index, anchor } = book.resolveCFI(cfi);
      if (index < 0 || index >= sections.length) return null;
      return cfiPlace(await chapter(index), { section: index, anchor });
    },
    async cfiOf(range) {
      const { text } = await chapter(range.section);
      const dom = rangeAt(text, range.start, range.end);
      if (dom === null) throw new EpubUnreadableError('that chapter has no words to place');
      return joinIndir(sectionAt(sections, range.section).cfi, fromRange(dom));
    },
    sectionOfPath(path) {
      const index = sections.findIndex((section) => section.id === path);
      return index === -1 ? null : index;
    },
    async show({ section, host, appearance, events }) {
      const { doc, text } = await chapter(section);
      const path = sectionAt(sections, section).id;
      const source = await chapterSource({ chapter: doc, text, path, files });
      return showChapter({ host, chapter: source, appearance, events });
    },
    close() {
      parsed.clear();
      texts.clear();
      book.destroy();
    },
  };
}

function sectionAt(sections: EPUB['sections'], section: number) {
  const found = sections[section];
  if (found === undefined) throw new EpubUnreadableError(`it has no chapter ${section + 1}`);
  return found;
}

/** Reads the chapter at `path`, as XHTML, or as HTML when it is not well-formed, and makes it safe. */
async function readChapter(archive: BookArchive, path: string): Promise<Chapter> {
  const source = await archive.loadText(path);
  if (source === null) throw new EpubUnreadableError(`its chapter ${path} is missing`);
  const parser = new DOMParser();
  let doc = parser.parseFromString(source, 'application/xhtml+xml');
  // Read through the DOM's own members: a name in the chapter can shadow the document's (`unshadowed-dom.ts`).
  if (getElementsByTagName(doc, 'parsererror').length > 0 || documentElementOf(doc) === null) {
    // Many books' chapters are not well-formed XHTML: read as HTML, as every reader does.
    doc = parser.parseFromString(source, 'text/html');
  }
  makeChapterSafe(doc, path);
  return { doc, text: chapterText(doc) };
}

/** Where a CFI's range falls in its chapter's text; the chapter alone when the range is not in it. */
function cfiPlace(
  { doc, text }: Chapter,
  { section, anchor }: { section: number; anchor: (doc: Document) => Range },
): CfiPlace {
  let range: Range;
  try {
    range = anchor(doc);
  } catch {
    // A path this chapter does not have: the chapter is known, the place in it is not.
    return { section, range: null };
  }
  const start = offsetAt(text, range.startContainer, range.startOffset);
  const end = offsetAt(text, range.endContainer, range.endOffset);
  const place: BookRange = { section, start: Math.min(start, end), end: Math.max(start, end) };
  return { section, range: place.start === place.end ? null : place };
}

/**
 * The book's title and first author, a text in many languages read in its
 * first. foliate-js gives one author as itself and several as a list.
 */
function metadataOf(metadata: EpubMetadata): PdfMetadata {
  const authors = metadata.author;
  const first = Array.isArray(authors) ? authors[0] : authors;
  const author = typeof first === 'string' || first === undefined ? first : first.name;
  return { title: textOf(metadata.title ?? null), author: textOf(author ?? null) };
}

function textOf(value: LanguageMap | null): string | null {
  if (value === null) return null;
  const text = typeof value === 'string' ? value : (Object.values(value)[0] ?? '');
  return text.trim() === '' ? null : text.trim();
}

function contentsOf(book: EPUB, items: readonly TocItem[]): ContentsEntry[] {
  return items.map((item) => ({
    title: (item.label ?? '').trim(),
    section: item.href === null || item.href === undefined ? null : sectionOfHref(book, item.href),
    children: contentsOf(book, item.subitems ?? []),
  }));
}

function sectionOfHref(book: EPUB, href: string): number | null {
  try {
    const index = book.resolveHref(href)?.index ?? -1;
    return index < 0 ? null : index;
  } catch {
    // An entry whose link names no file of the book goes nowhere.
    return null;
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
