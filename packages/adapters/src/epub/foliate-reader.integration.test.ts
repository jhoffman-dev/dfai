// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { EpubProtectedError, EpubUnreadableError } from '@dfai/application';
import { findQuote } from '@dfai/domain';
import {
  fablesFixtureEpub,
  fixtureEpub,
  HARE_AND_TORTOISE,
  obfuscatedFontFixtureEpub,
  protectedFixtureEpub,
} from '../../../../tools/epub/fixture-epub.ts';
import { foliateEpubReader } from './foliate-reader.ts';

/*
 * foliate-js behind the EPUB reader's port (#505), against EPUBs made for the
 * test (tools/epub/fixture-epub.ts): what the package says, each chapter's
 * text, a CFI made for a stretch of a chapter and read back to the same
 * stretch, and the books it refuses — one locked with DRM, and bytes that
 * are no EPUB.
 */

const reader = foliateEpubReader();
const open = (bytes: Buffer) => reader.open(new Uint8Array(bytes));

describe('an EPUB opened from its bytes', () => {
  it('gives its title and author from its package, and its chapters and contents', async () => {
    const book = await open(fablesFixtureEpub());
    expect(book.metadata).toEqual({ title: 'Fables of Brightwater', author: 'Mara Quill' });
    expect(book.sectionCount).toBe(2);
    expect(book.contents).toEqual([
      { title: 'The Hare and the Tortoise', section: 0, children: [] },
      { title: 'The Ant and the Grasshopper', section: 1, children: [] },
    ]);
    expect(book.sectionOfPath('OEBPS/grasshopper.xhtml')).toBe(1);
    expect(book.sectionOfPath('OEBPS/nav.xhtml')).toBeNull();
    book.close();
  });

  it("reads a chapter's words in order, its blocks set apart, and nothing of its head", async () => {
    const book = await open(fablesFixtureEpub());
    const text = await book.sectionText(0);
    expect(text.trimStart().startsWith('The Hare and the Tortoise\n')).toBe(true);
    expect(text).toContain('Slow but steady wins the race.');
    expect(text).not.toContain('text-indent');
    expect(text.replace(/\s+/g, ' ')).toContain(
      'A Hare one day ridiculed the short feet and slow pace of the Tortoise, who replied, laughing:',
    );
    book.close();
  });

  it('makes a CFI for a stretch of a chapter that reads back as the same stretch', async () => {
    const book = await open(fablesFixtureEpub());
    const text = await book.sectionText(1);
    const at = text.indexOf('When the winter came');
    const range = { section: 1, start: at, end: at + 'When the winter came'.length };
    const cfi = await book.cfiOf(range);
    expect(cfi).toMatch(/^epubcfi\(\/6\/4(\[c2\])?!\/4\/.+\)$/);
    expect(await book.placeOfCfi(cfi)).toEqual({ section: 1, range });
    book.close();
  });

  it('reads the same CFI in another copy of the book, as a reader opening it again does', async () => {
    const first = await open(fablesFixtureEpub());
    const text = await first.sectionText(0);
    const at = text.indexOf('fell fast asleep');
    const cfi = await first.cfiOf({ section: 0, start: at, end: at + 16 });
    first.close();
    const again = await open(fablesFixtureEpub());
    const place = await again.placeOfCfi(cfi);
    const words =
      place?.range === null || place === null ? '' : text.slice(place.range.start, place.range.end);
    expect(words).toBe('fell fast asleep');
    again.close();
  });

  it('knows the chapter of a CFI whose path that chapter does not have, and not where in it', async () => {
    const book = await open(fablesFixtureEpub());
    expect(await book.placeOfCfi('epubcfi(/6/2!/4/99/1:0)')).toEqual({ section: 0, range: null });
    book.close();
  });

  it('finds a quote in the chapter text it gives, as re-anchoring does when a CFI misses', async () => {
    const book = await open(fablesFixtureEpub());
    const text = await book.sectionText(0);
    expect(
      findQuote(text, { exact: 'slow but steady pace', prefix: 'went on with a ', suffix: '' }),
    ).not.toBeNull();
    book.close();
  });

  it('opens a book whose only encryption is an obfuscated font', async () => {
    const book = await open(obfuscatedFontFixtureEpub());
    expect(book.metadata.title).toBe('Fables with a Font');
    book.close();
  });

  it('reads a chapter that is not well-formed XHTML as HTML, as every reader does', async () => {
    const book = await open(
      fixtureEpub({
        title: 'Loose',
        chapters: [
          { file: 'loose.xhtml', title: 'Loose', body: '<p>An unclosed paragraph<br>and a break' },
        ],
      }),
    );
    expect(await book.sectionText(0)).toContain('An unclosed paragraph');
    book.close();
  });
});

describe('an EPUB the reader refuses', () => {
  it('refuses a book locked with DRM, before reading any of it', async () => {
    await expect(open(protectedFixtureEpub())).rejects.toBeInstanceOf(EpubProtectedError);
  });

  it('refuses bytes that are not a ZIP, and a ZIP that is no EPUB', async () => {
    await expect(
      reader.open(new TextEncoder().encode('%PDF-1.4 not a book')),
    ).rejects.toBeInstanceOf(EpubUnreadableError);
    const { storedZip } = await import('../../../../tools/epub/stored-zip.ts');
    await expect(open(storedZip([{ name: 'readme.txt', data: 'hello' }]))).rejects.toBeInstanceOf(
      EpubUnreadableError,
    );
  });

  it("leaves the caller's bytes as they were", async () => {
    const bytes = new Uint8Array(fablesFixtureEpub());
    const before = bytes.slice();
    (await reader.open(bytes)).close();
    expect(bytes).toEqual(before);
  });

  it('refuses a book with no chapter it can name', async () => {
    const book = await open(fixtureEpub({ title: 'One', chapters: [HARE_AND_TORTOISE] }));
    await expect(book.cfiOf({ section: 3, start: 0, end: 1 })).rejects.toBeInstanceOf(
      EpubUnreadableError,
    );
    book.close();
  });
});

describe('a long book, held a little at a time', () => {
  const originalParse = DOMParser.prototype.parseFromString;
  /** Each chapter's title as it is parsed, by the reader or by foliate-js. */
  function parsedChapters() {
    const parsed: string[] = [];
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(function (
      this: DOMParser,
      source: string,
      type: DOMParserSupportedType,
    ) {
      const title = /<title>([^<]*)<\/title>/.exec(source)?.[1];
      if (title?.startsWith('Part ')) parsed.push(title);
      return originalParse.call(this, source, type);
    });
    return { parsed, restore: () => parse.mockRestore() };
  }
  const parts = Array.from({ length: 6 }, (_, at) => ({
    file: `part-${at + 1}.xhtml`,
    title: `Part ${at + 1}`,
    body: `<p>The words of part ${at + 1}.</p>`,
  }));

  it("keeps every chapter's text once read, but parses a chapter again once three others were since", async () => {
    const book = await open(fixtureEpub({ title: 'A Long Book', chapters: parts }));
    const { parsed, restore } = parsedChapters();
    try {
      for (let section = 0; section < parts.length; section += 1) await book.sectionText(section);
      expect(parsed).toEqual(parts.map((part) => part.title));
      for (let section = 0; section < parts.length; section += 1) await book.sectionText(section);
      expect(parsed).toHaveLength(parts.length);
      // Parts 4–6 are the three parsed last; a CFI in part 6 needs no parse, one in part 1 does.
      const last = await book.sectionText(5);
      await book.cfiOf({ section: 5, start: 0, end: last.trim().length });
      expect(parsed).toHaveLength(parts.length);
      const first = await book.sectionText(0);
      const cfi = await book.cfiOf({ section: 0, start: 0, end: first.trim().length });
      expect(parsed.slice(parts.length)).toEqual(['Part 1']);
      expect((await book.placeOfCfi(cfi))?.section).toBe(0);
    } finally {
      restore();
      book.close();
    }
  });
});
