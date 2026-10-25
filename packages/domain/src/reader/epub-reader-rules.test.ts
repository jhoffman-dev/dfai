import { describe, expect, it } from 'vitest';
import type { EpubAnchor } from '../highlights/anchor.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  BOOK_FONT_DEFAULT,
  BOOK_FONT_SIZES,
  bookFontLabel,
  largerBookFont,
  smallerBookFont,
} from './book-font.ts';
import { documentKindOf, isEpubName, withoutDocumentExtension } from './document-kind.ts';
import { placeOfFile } from './document-place.ts';
import { bookReference, EPUB_FRAME_SANDBOX, epubFramePolicy } from './epub-frame.ts';
import { epubProtection, looksLikeEpub, protectedEpubMessage } from './epub-library.ts';
import {
  bookQuoteAt,
  epubHighlight,
  findInBook,
  inBookOrder,
  placeByBookWords,
  placeInCfiSection,
  sectionTitle,
  trimmedBookRange,
  type BookPlacement,
} from './epub-text.ts';
import { MOST_MATCHES } from './find-in-document.ts';
import {
  checkIncomingDocument,
  libraryFileName,
  literatureDetails,
  MAX_DOCUMENT_BYTES,
  notADocumentMessage,
} from './pdf-library.ts';

/*
 * The EPUB reader's rules (#505): which files are books, what adding one
 * names and refuses, what a book may load, what a selection in a chapter
 * becomes, where a stored highlight is drawn, find in a book, and the text
 * size.
 */

describe('which files are documents', () => {
  it('tells a PDF and an EPUB by their names, in any case, and nothing else', () => {
    expect(documentKindOf('Library/Fables.EPUB ')).toBe('epub');
    expect(documentKindOf('paper.pdf')).toBe('pdf');
    expect(documentKindOf('notes.epub.md')).toBeNull();
    expect(documentKindOf('epub')).toBeNull();
    expect(isEpubName('a.epub')).toBe(true);
    expect(isEpubName('a.pdf')).toBe(false);
  });

  it('takes a document extension off a name, and only that', () => {
    expect(withoutDocumentExtension('Fables.epub')).toBe('Fables');
    expect(withoutDocumentExtension('Paper.PDF ')).toBe('Paper');
    expect(withoutDocumentExtension('Notes.md')).toBe('Notes.md');
  });

  it('opens an EPUB from Pages in its reader, as a PDF', () => {
    const path = createVaultPath('Library/fables.epub');
    expect(placeOfFile(path)).toEqual({ kind: 'document', path });
    expect(placeOfFile(createVaultPath('Library/fables.md'))).toMatchObject({ kind: 'note' });
  });
});

describe('adding an EPUB to the library', () => {
  it('accepts an EPUB by its name and size, and refuses anything else plainly', () => {
    expect(checkIncomingDocument({ name: 'Fables.epub', size: 10 }, 'epub')).toEqual({
      kind: 'accepted',
    });
    expect(checkIncomingDocument({ name: 'fables.pdf', size: 10 }, 'epub')).toEqual({
      kind: 'refused',
      message: '“fables.pdf” is not an EPUB.',
    });
    expect(checkIncomingDocument({ name: 'a.epub', size: 0 }, 'epub')).toMatchObject({
      message: '“a.epub” is empty.',
    });
    const big = checkIncomingDocument({ name: 'big.epub', size: MAX_DOCUMENT_BYTES + 1 }, 'epub');
    expect(big).toMatchObject({ kind: 'refused' });
    expect(big.kind === 'refused' && big.message).toContain(
      'An EPUB in the library can be at most 32 MB.',
    );
    expect(notADocumentMessage('x.txt', 'pdf')).toBe('“x.txt” is not a PDF.');
  });

  it('names the copy after the file, safe for a link, ending in .epub', () => {
    expect(libraryFileName('Fables #2 [draft].epub', 'epub')).toBe('Fables -2 -draft-.epub');
    expect(libraryFileName('.epub', 'epub')).toBe('Untitled.epub');
    expect(libraryFileName('fables', 'epub')).toBe('fables.epub');
  });

  it("titles the note from the book's package, else from the file's name", () => {
    const file = createVaultPath('Library/fables-of-brightwater.epub');
    expect(
      literatureDetails({
        metadata: { title: 'Fables of Brightwater', author: 'Mara Quill' },
        file,
      }),
    ).toEqual({ title: 'Fables of Brightwater', author: 'Mara Quill' });
    expect(literatureDetails({ metadata: { title: '  ', author: null }, file })).toEqual({
      title: 'fables-of-brightwater',
      author: null,
    });
  });

  it('tells an EPUB by its first bytes, a ZIP archive', () => {
    expect(looksLikeEpub(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toBe(true);
    expect(looksLikeEpub(new TextEncoder().encode('%PDF-1.4'))).toBe(false);
    expect(looksLikeEpub(new Uint8Array([0x50, 0x4b]))).toBe(false);
  });
});

describe('a book locked with DRM', () => {
  const aes = 'http://www.w3.org/2001/04/xmlenc#aes128-cbc';
  const idpf = 'http://www.idpf.org/2008/embedding';
  const adobe = 'http://ns.adobe.com/pdf/enc#RC';

  it('is open with no encryption, or with only its fonts obfuscated', () => {
    expect(epubProtection({ encrypted: [], entries: ['OEBPS/a.xhtml'] })).toEqual({ kind: 'open' });
    expect(
      epubProtection({
        encrypted: [
          { algorithm: idpf, uri: 'OEBPS/fonts/serif.otf' },
          { algorithm: adobe, uri: 'OEBPS/fonts/sans.ttf' },
        ],
        entries: [],
      }),
    ).toEqual({ kind: 'open' });
  });

  it('is protected when a chapter is encrypted, or anything by a cipher', () => {
    expect(
      epubProtection({ encrypted: [{ algorithm: aes, uri: 'OEBPS/a.xhtml' }], entries: [] }),
    ).toEqual({ kind: 'protected' });
    expect(
      epubProtection({ encrypted: [{ algorithm: aes, uri: 'OEBPS/fonts/a.otf' }], entries: [] }),
    ).toEqual({ kind: 'protected' });
  });

  it('is protected when an obfuscation is used on a chapter, which is no font', () => {
    expect(
      epubProtection({ encrypted: [{ algorithm: idpf, uri: 'OEBPS/ch1.xhtml' }], entries: [] }),
    ).toEqual({ kind: 'protected' });
  });

  it('is protected when its encryption names no method', () => {
    expect(epubProtection({ encrypted: [{ algorithm: null, uri: null }], entries: [] })).toEqual({
      kind: 'protected',
    });
  });

  it("is protected when it carries a DRM scheme's licence or keys, in any case", () => {
    expect(epubProtection({ encrypted: [], entries: ['META-INF/rights.xml'] }).kind).toBe(
      'protected',
    );
    expect(epubProtection({ encrypted: [], entries: ['meta-inf/SINF.xml'] }).kind).toBe(
      'protected',
    );
  });

  it('is refused in plain words that name the book', () => {
    expect(protectedEpubMessage('locked.epub')).toBe(
      "“locked.epub” is protected with DRM, so DFAI can't open it. Books from the Kindle store, Apple Books and Kobo usually are; a DRM-free copy of the book opens.",
    );
  });
});

describe('what a book may load', () => {
  const HASH = 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=';

  it("runs only DFAI's script, by its hash, and loads nothing from outside the book", () => {
    const policy = epubFramePolicy(HASH);
    for (const rule of [
      "default-src 'none'",
      `script-src 'sha256-${HASH}'`,
      'img-src data:',
      'font-src data:',
      "connect-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ]) {
      expect(policy).toContain(rule);
    }
    expect(policy).not.toMatch(/https?:|blob:|'self'|unsafe-eval|'unsafe-inline'[^;]*script/);
    expect(policy.match(/script-src [^;]*/)?.[0]).toBe(`script-src 'sha256-${HASH}'`);
  });

  it('is made only from a SHA-256 hash, so nothing else can be written into it', () => {
    for (const bad of [
      '',
      'abc',
      `${HASH}; script-src *`,
      `${HASH.slice(0, -1)}`,
      "x' 'unsafe-inline",
    ]) {
      expect(() => epubFramePolicy(bad), bad).toThrow(/not a SHA-256 hash/);
    }
  });

  it('gives the frame an opaque origin: scripts, and nothing of the app', () => {
    expect(EPUB_FRAME_SANDBOX).toBe('allow-scripts');
    expect(EPUB_FRAME_SANDBOX).not.toContain('allow-same-origin');
  });

  it('reads a reference against the file it is in, inside the book', () => {
    const from = 'OEBPS/text/ch1.xhtml';
    expect(bookReference({ from, ref: 'ch2.xhtml#second' })).toEqual({
      kind: 'inside',
      path: 'OEBPS/text/ch2.xhtml',
      fragment: 'second',
    });
    expect(bookReference({ from, ref: '../images/a%20b.png?x=1' })).toEqual({
      kind: 'inside',
      path: 'OEBPS/images/a b.png',
      fragment: null,
    });
    expect(bookReference({ from, ref: '/OEBPS/style.css' })).toEqual({
      kind: 'inside',
      path: 'OEBPS/style.css',
      fragment: null,
    });
    expect(bookReference({ from, ref: '#note-3' })).toEqual({
      kind: 'inside',
      path: from,
      fragment: 'note-3',
    });
  });

  it('takes anything with a scheme, protocol-relative or out of the archive as outside', () => {
    const from = 'OEBPS/ch1.xhtml';
    for (const ref of [
      'https://beacon.example.com/a.png',
      'HTTP://example.com',
      '//example.com/a.png',
      'javascript:alert(1)',
      'mailto:mara@example.com',
      'file:///etc/passwd',
      '../../outside.png',
      '%zz.png',
      '',
    ]) {
      expect(bookReference({ from, ref }), ref).toEqual({ kind: 'outside' });
    }
  });

  it('keeps a picture written into the book as data', () => {
    expect(bookReference({ from: 'a.xhtml', ref: ' data:image/png;base64,AAA' })).toEqual({
      kind: 'data',
    });
  });
});

describe('a selection in a chapter', () => {
  const text = 'The Hare and the Tortoise\n\n  A Hare one day ridiculed\n  the short feet.  ';

  it('leaves out the space at either end, and puts its ends in order', () => {
    const at = text.indexOf('A Hare');
    expect(trimmedBookRange({ section: 1, start: at + 24, end: at - 3 }, text)).toEqual({
      section: 1,
      start: at,
      end: at + 'A Hare one day ridiculed'.length,
    });
    expect(trimmedBookRange({ section: 0, start: 25, end: 29 }, text)).toBeNull();
    expect(trimmedBookRange({ section: 0, start: Number.NaN, end: 3 }, text)).toEqual({
      section: 0,
      start: 0,
      end: 3,
    });
  });

  it('keeps its words and surroundings as they read, each run of space one space', () => {
    const at = text.indexOf('ridiculed');
    const quote = bookQuoteAt({ section: 0, start: at, end: text.indexOf('feet') + 4 }, text);
    expect(quote.exact).toBe('ridiculed the short feet');
    expect(quote.prefix.endsWith('one day ')).toBe(true);
    expect(quote.prefix).not.toMatch(/\s\s/);
    expect(quote.suffix).toBe('. ');
  });

  it('becomes a highlight anchored by its CFI and its words, the quote its words', () => {
    const quote = { exact: 'fell fast asleep', prefix: 'wayside, ', suffix: '. At' };
    expect(
      epubHighlight({
        cfi: 'epubcfi(/6/2!/4/8/1:10,/1:0,/1:16)',
        quote,
        style: { mark: 'underline', color: 'blue' },
        comment: 'The nap.',
      }),
    ).toEqual({
      quote: 'fell fast asleep',
      anchor: { kind: 'epub', cfi: 'epubcfi(/6/2!/4/8/1:10,/1:0,/1:16)', quote },
      style: { mark: 'underline', color: 'blue' },
      comment: 'The nap.',
    });
    expect(
      'comment' in
        epubHighlight({
          cfi: 'epubcfi(/6/2!/4)',
          quote,
          style: { mark: 'highlight', color: 'yellow' },
        }),
    ).toBe(false);
  });
});

describe('where a stored EPUB highlight is drawn', () => {
  const chapter = 'Slow but steady wins the race. Then the race was run again; slow but steady.';
  const anchor = (exact: string, prefix = '', suffix = ''): EpubAnchor => ({
    kind: 'epub',
    cfi: 'epubcfi(/6/2!/4/2/1:0)',
    quote: { exact, prefix, suffix },
  });

  it('is where its CFI points, when the words there are its own, space compared loosely', () => {
    const range = { section: 0, start: 0, end: 30 };
    expect(
      placeInCfiSection({
        anchor: anchor('Slow  but steady\nwins the race.'),
        atCfi: { section: 0, range },
        text: chapter,
      }),
    ).toEqual({ kind: 'cfi', range });
  });

  it("is found by its words in the CFI's chapter when the CFI points at other words", () => {
    const placed = placeInCfiSection({
      anchor: anchor('the race was run', 'Then '),
      atCfi: { section: 2, range: { section: 2, start: 0, end: 4 } },
      text: chapter,
    });
    expect(placed).toEqual({
      kind: 'words',
      range: { section: 2, start: chapter.indexOf('the race was'), end: chapter.indexOf(' again') },
    });
  });

  it('is found by its words when the CFI names its chapter but no place in it', () => {
    expect(
      placeInCfiSection({
        anchor: anchor('wins the race'),
        atCfi: { section: 0, range: null },
        text: chapter,
      }),
    ).toMatchObject({ kind: 'words' });
  });

  it("is not placed in the CFI's chapter when its words are not there, or are there twice alike", () => {
    expect(
      placeInCfiSection({
        anchor: anchor('A sentence never written'),
        atCfi: { section: 0, range: null },
        text: chapter,
      }),
    ).toBeNull();
    expect(
      placeInCfiSection({
        anchor: anchor('the race'),
        atCfi: { section: 0, range: null },
        text: chapter,
      }),
    ).toBeNull();
    // A CFI that points at a blank stretch is no match for a quote of blank words.
    expect(
      placeInCfiSection({
        anchor: anchor('  '),
        atCfi: { section: 0, range: { section: 0, start: 4, end: 5 } },
        text: chapter,
      }),
    ).toBeNull();
  });

  it('is found by its words in another chapter, nearest the one its CFI named first', () => {
    const sections = [
      'nothing here',
      'the tide keeps its hours',
      'nor here',
      'the tide keeps its hours',
    ];
    expect(placeByBookWords({ anchor: anchor('the tide keeps'), near: 3, sections })).toEqual({
      kind: 'words',
      range: { section: 3, start: 0, end: 14 },
    });
    expect(placeByBookWords({ anchor: anchor('the tide keeps'), near: 0, sections })).toMatchObject(
      {
        range: { section: 1 },
      },
    );
  });

  it('is lost when its words are nowhere in the book, or the book has no chapters', () => {
    expect(
      placeByBookWords({ anchor: anchor('never written'), near: 0, sections: ['a', 'b'] }),
    ).toEqual({
      kind: 'lost',
    });
    expect(placeByBookWords({ anchor: anchor('a'), near: 0, sections: [] })).toEqual({
      kind: 'lost',
    });
  });

  it('is listed in the order of the book, the lost last, ties in the note’s order', () => {
    const at = (section: number, start: number): BookPlacement => ({
      kind: 'cfi',
      range: { section, start, end: start + 1 },
    });
    const placed = [
      { id: 'lost', placement: { kind: 'lost' } as BookPlacement },
      { id: 'b', placement: at(1, 5) },
      { id: 'a', placement: at(0, 9) },
      { id: 'c', placement: at(1, 2) },
      { id: 'd', placement: at(1, 2) },
    ];
    expect(inBookOrder(placed).map((each) => each.id)).toEqual(['a', 'c', 'd', 'b', 'lost']);
  });
});

describe('find in a book', () => {
  it('finds every copy chapter by chapter, without case and across a line break', () => {
    const { matches, more } = findInBook(
      ['The Grasshopper\nsang', 'no', 'a grasshopper  sang'],
      'grasshopper sang',
    );
    expect(more).toBe(false);
    expect(matches).toEqual([
      { section: 0, start: 4, end: 20 },
      { section: 2, start: 2, end: 19 },
    ]);
  });

  it('finds nothing for a blank phrase, and stops at the most it gives', () => {
    expect(findInBook(['a'], '  ')).toEqual({ matches: [], more: false });
    const crowded = findInBook(['x '.repeat(MOST_MATCHES + 1)], 'x');
    expect(crowded.matches).toHaveLength(MOST_MATCHES);
    expect(crowded.more).toBe(true);
  });
});

describe("what a book's chapter is called", () => {
  const contents = [
    { title: 'Cover', section: 0, children: [] },
    {
      title: 'Part One',
      section: 2,
      children: [{ title: 'The Hare and the Tortoise', section: 3, children: [] }],
    },
    { title: 'Nowhere', section: null, children: [] },
  ];

  it('is the last contents entry at or before it, children included', () => {
    expect(sectionTitle({ section: 0, contents })).toBe('Cover');
    expect(sectionTitle({ section: 2, contents })).toBe('Part One');
    expect(sectionTitle({ section: 5, contents })).toBe('The Hare and the Tortoise');
  });

  it('is its place in the book when no entry comes before it, or the one that does has no title', () => {
    expect(
      sectionTitle({ section: 1, contents: [{ title: 'Late', section: 4, children: [] }] }),
    ).toBe('Part 2');
    expect(
      sectionTitle({ section: 0, contents: [{ title: '  ', section: 0, children: [] }] }),
    ).toBe('Part 1');
  });
});

describe("the reader's text size", () => {
  it('steps up and down through the sizes, stopping at either end', () => {
    expect(BOOK_FONT_SIZES).toContain(BOOK_FONT_DEFAULT);
    expect(largerBookFont(100)).toBe(110);
    expect(smallerBookFont(100)).toBe(90);
    expect(largerBookFont(200)).toBe(200);
    expect(smallerBookFont(80)).toBe(80);
    expect(largerBookFont(103)).toBe(110);
    expect(bookFontLabel(125)).toBe('125%');
  });
});
