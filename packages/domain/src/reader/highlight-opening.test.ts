import { describe, expect, it } from 'vitest';
import type { HighlightAnchor, SourceKind } from '../highlights/anchor.ts';
import type { HighlightBlock } from '../highlights/highlight-block.ts';
import type { LiteratureNote } from '../highlights/literature-note.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import {
  highlightChip,
  highlightOpening,
  namesDocument,
  documentLinkTarget,
  placeLabel,
  readerDocumentOf,
  readerLinkLabel,
} from './highlight-opening.ts';

/*
 * Where a followed highlight opens (#506): the reader for a source the app
 * can read, the note at the block for any other; and what its chip says.
 */

const NOTE = createVaultPath('Library/The Lantern Keepers.md');
const PDF = createVaultPath('Library/the-lantern-keepers.pdf');

const source = (overrides: Partial<LiteratureNote> = {}): LiteratureNote => ({
  kind: 'pdf',
  title: 'The Lantern Keepers',
  author: 'Mara Quill',
  file: PDF,
  ...overrides,
});

const PDF_ANCHOR: HighlightAnchor = {
  kind: 'pdf',
  page: 3,
  quote: { exact: 'The last lamp', prefix: '', suffix: '' },
  rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }],
};

const highlight = (anchor: HighlightAnchor, id = 'k3x9q2'): HighlightBlock => ({
  id,
  quote: 'The last lamp',
  comment: '',
  style: { mark: 'highlight', color: 'yellow' },
  anchor,
  start: 0,
  markerEnd: 0,
  quoteEnd: 0,
  end: 0,
});

describe('where following a block opens', () => {
  const opening = (
    literature: Parameters<typeof highlightOpening>[0]['literature'],
    readers?: readonly SourceKind[],
  ) =>
    highlightOpening({
      note: NOTE,
      blockId: 'k3x9q2',
      literature,
      ...(readers !== undefined && { readers }),
    });

  it("opens a PDF's highlight in the reader, at the highlight", () => {
    expect(opening({ source: source(), highlightIds: ['a1b2c3', 'k3x9q2'] })).toEqual({
      kind: 'reader',
      source: 'pdf',
      document: PDF,
      highlightId: 'k3x9q2',
    });
  });

  it('opens a Kindle highlight in its note at the block: a Kindle book has no reader', () => {
    expect(
      opening({ source: source({ kind: 'kindle', file: null }), highlightIds: ['k3x9q2'] }),
    ).toEqual({ kind: 'note', note: NOTE, blockId: 'k3x9q2' });
  });

  it("opens an EPUB's highlight in the reader (#505), and in its note where no reader is given", () => {
    const epub = {
      source: source({ kind: 'epub', file: createVaultPath('Library/b.epub') }),
      highlightIds: ['k3x9q2'],
    };
    expect(opening(epub, ['pdf'])).toEqual({ kind: 'note', note: NOTE, blockId: 'k3x9q2' });
    expect(opening(epub)).toEqual({
      kind: 'reader',
      source: 'epub',
      document: 'Library/b.epub',
      highlightId: 'k3x9q2',
    });
  });

  it('opens a block of a literature note that is not a highlight in the note', () => {
    expect(opening({ source: source(), highlightIds: ['a1b2c3'] })).toEqual({
      kind: 'note',
      note: NOTE,
      blockId: 'k3x9q2',
    });
  });

  it('opens a block of any other note in the note', () => {
    expect(opening(null)).toEqual({ kind: 'note', note: NOTE, blockId: 'k3x9q2' });
  });

  it('opens a PDF literature note with no file in the note: there is no document to read', () => {
    expect(opening({ source: source({ file: null }), highlightIds: ['k3x9q2'] })).toEqual({
      kind: 'note',
      note: NOTE,
      blockId: 'k3x9q2',
    });
  });
});

describe('what a highlight in its note offers', () => {
  it('is "Open in PDF" for a PDF with its file', () => {
    expect(readerLinkLabel(source())).toBe('Open in PDF');
  });

  it('is nothing for a Kindle book, a PDF with no file, or a note that is no literature note', () => {
    expect(readerLinkLabel(source({ kind: 'kindle', file: null }))).toBeNull();
    expect(readerLinkLabel(source({ file: null }))).toBeNull();
    expect(readerLinkLabel(null)).toBeNull();
  });

  it('is "Open in EPUB" for an EPUB with its file, and nothing where no EPUB reader is given', () => {
    const epub = source({ kind: 'epub', file: createVaultPath('Library/b.epub') });
    expect(readerLinkLabel(epub)).toBe('Open in EPUB');
    expect(readerLinkLabel(epub, ['pdf'])).toBeNull();
  });

  it('is nothing for an EPUB note whose file is not an EPUB, as for a PDF note naming no PDF', () => {
    expect(
      readerLinkLabel(source({ kind: 'epub', file: createVaultPath('Library/b.md') })),
    ).toBeNull();
    expect(
      readerLinkLabel(source({ kind: 'epub', file: createVaultPath('Library/b.pdf') })),
    ).toBeNull();
  });
});

describe('where in its source a highlight is', () => {
  it("names a PDF highlight's page", () => {
    expect(placeLabel(PDF_ANCHOR)).toBe('p. 3');
  });

  it("names a Kindle highlight's location, or its page when the export gave no location", () => {
    expect(
      placeLabel({ kind: 'kindle', location: { start: 1234, end: 1240 }, annotationId: null }),
    ).toBe('loc. 1234');
    expect(placeLabel({ kind: 'kindle', location: null, page: 17, annotationId: null })).toBe(
      'p. 17',
    );
    expect(placeLabel({ kind: 'kindle', location: null, annotationId: null })).toBeNull();
  });

  it('names no place for an EPUB, whose CFI means nothing read', () => {
    expect(
      placeLabel({ kind: 'epub', cfi: 'epubcfi(/6/4!/4/2)', quote: PDF_ANCHOR.quote! }),
    ).toBeNull();
  });
});

describe("a shown highlight's chip", () => {
  it("says the source's title and page, in its kind's hue, and that it opens the reader", () => {
    expect(highlightChip(source(), highlight(PDF_ANCHOR))).toEqual({
      kind: 'pdf',
      hue: 'red',
      title: 'The Lantern Keepers',
      place: 'p. 3',
      opensInReader: true,
    });
  });

  it("says a Kindle highlight's location, in another hue, and that it opens its note", () => {
    const kindle = highlight({
      kind: 'kindle',
      location: { start: 41, end: 44 },
      annotationId: null,
    });
    expect(highlightChip(source({ kind: 'kindle', file: null }), kindle)).toEqual({
      kind: 'kindle',
      hue: 'orange',
      title: 'The Lantern Keepers',
      place: 'loc. 41',
      opensInReader: false,
    });
  });
});

describe('the PDF a wiki link names', () => {
  const known = [
    PDF,
    createVaultPath('Archive/the-lantern-keepers.pdf'),
    createVaultPath('Areas/Fog.pdf'),
  ];

  it('is none for a link to anything but a PDF', () => {
    expect(documentLinkTarget('The Lantern Keepers', known)).toBeNull();
    expect(documentLinkTarget('notes.pdf.md', known)).toBeNull();
  });

  it('is the known PDF at the path the link writes, in any case', () => {
    expect(documentLinkTarget('library/The-Lantern-Keepers.PDF', known)).toBe(PDF);
    expect(documentLinkTarget(' /Library/the-lantern-keepers.pdf ', known)).toBe(PDF);
  });

  it('is the one known PDF of the name a link gives alone', () => {
    expect(documentLinkTarget('fog.pdf', known)).toBe('Areas/Fog.pdf');
  });

  it('is none when no file of the vault is called so: a link never names a file that is not there', () => {
    expect(documentLinkTarget('Elsewhere/new.pdf', known)).toBeNull();
    expect(documentLinkTarget('new.pdf', [])).toBeNull();
  });

  it('is the shortest path of the name two files share, then the first alphabetically', () => {
    // Like Obsidian, a link picks one of the files that match; this one picks the same one every time.
    expect(documentLinkTarget('the-lantern-keepers.pdf', known)).toBe(
      'Archive/the-lantern-keepers.pdf',
    );
    expect(documentLinkTarget('the-lantern-keepers.pdf', [...known].reverse())).toBe(
      'Archive/the-lantern-keepers.pdf',
    );
    const tied = [createVaultPath('B/a.pdf'), createVaultPath('A/a.pdf')];
    expect(documentLinkTarget('a.pdf', tied)).toBe('A/a.pdf');
    expect(documentLinkTarget('a.pdf', [...tied].reverse())).toBe('A/a.pdf');
  });

  it('is the file whose path ends with what the link writes, not one that merely ends the same letters', () => {
    const deep = createVaultPath('Library/Courses/reading.pdf');
    expect(documentLinkTarget('Courses/reading.pdf', [deep])).toBe(deep);
    expect(documentLinkTarget('ses/reading.pdf', [deep])).toBeNull();
  });

  it('is the exact path before any file that only ends with it', () => {
    const exact = createVaultPath('reading.pdf');
    const deeper = createVaultPath('A/reading.pdf');
    expect(documentLinkTarget('reading.pdf', [deeper, exact, exact])).toBe(exact);
  });

  it('is none for a link that is no vault path', () => {
    expect(documentLinkTarget('../outside.pdf', known)).toBeNull();
    expect(documentLinkTarget('a\\b.pdf', known)).toBeNull();
  });
});

describe('whether a wiki link names a PDF', () => {
  it('is so for a target ending .pdf, in any case, and no other', () => {
    expect(namesDocument(' Reading.PDF ')).toBe('pdf');
    expect(namesDocument('Budget review')).toBeNull();
    expect(namesDocument('Budget review.pdf.md')).toBeNull();
  });
});

describe('a link to an EPUB (#505)', () => {
  const BOOK = createVaultPath('Library/fables-of-brightwater.epub');
  const files = [PDF, BOOK, createVaultPath('Archive/fables.pdf')];

  it('names the EPUB it ends with, and never a file of another kind', () => {
    expect(namesDocument('fables-of-brightwater.EPUB')).toBe('epub');
    expect(documentLinkTarget('fables-of-brightwater.epub', files)).toBe(BOOK);
    expect(documentLinkTarget('Library/fables-of-brightwater.epub', files)).toBe(BOOK);
    // A PDF of the same stem is not the book.
    expect(documentLinkTarget('fables.epub', files)).toBeNull();
    expect(documentLinkTarget('fables.pdf', files)).toBe('Archive/fables.pdf');
  });
});

describe("what a literature note's bar offers to open", () => {
  it('is the PDF or the EPUB, by its kind', () => {
    expect(readerDocumentOf(source())).toEqual({ file: PDF, label: 'Open PDF' });
    const book = createVaultPath('Library/b.epub');
    expect(readerDocumentOf(source({ kind: 'epub', file: book }))).toEqual({
      file: book,
      label: 'Open EPUB',
    });
  });

  it('is nothing for a Kindle book, a note naming no file of its kind, or no literature note', () => {
    expect(readerDocumentOf(source({ kind: 'kindle', file: null }))).toBeNull();
    expect(readerDocumentOf(source({ kind: 'epub', file: PDF }))).toBeNull();
    expect(readerDocumentOf(source({ file: null }))).toBeNull();
    expect(readerDocumentOf(null)).toBeNull();
    expect(readerDocumentOf(source(), ['epub'])).toBeNull();
  });
});
