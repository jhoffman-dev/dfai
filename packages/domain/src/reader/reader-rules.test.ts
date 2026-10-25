import { describe, expect, it } from 'vitest';
import { createVaultPath } from '../vault/vault-path.ts';
import { placeOfFile } from './document-place.ts';
import { findInDocument, MOST_MATCHES, stepMatch } from './find-in-document.ts';
import {
  areaImageName,
  checkIncomingDocument,
  isPdfName,
  libraryFileName,
  libraryFolder,
  literatureDetails,
  looksLikePdf,
  MAX_DOCUMENT_BYTES,
} from './pdf-library.ts';
import { pdfPageText } from './pdf-page-text.ts';
import {
  clampZoom,
  fitWidthZoom,
  LARGEST_ZOOM,
  SMALLEST_ZOOM,
  zoomIn,
  zoomLabel,
  zoomOut,
} from './zoom.ts';

const page = (text: string) =>
  pdfPageText([
    { text, box: { x: 0, y: 0.1, width: text.length * 0.01, height: 0.02 }, endsLine: false },
  ]);

describe('find in a document', () => {
  const pages = [
    page('A light kept is a\npromise kept.'),
    page('No lights here.'),
    page('a LIGHT kept'),
  ];

  it('finds every copy in reading order, without case and across a line break', () => {
    const { matches, more } = findInDocument(pages, 'light  kept');
    expect(more).toBe(false);
    expect(matches.map(({ page: at, start, end }) => [at, start, end])).toEqual([
      [1, 2, 12],
      [3, 2, 12],
    ]);
    expect(findInDocument(pages, 'a promise').matches[0]).toMatchObject({ page: 1, start: 16 });
    expect(matches[0]?.rects.length).toBeGreaterThan(0);
  });

  it('takes the phrase as words, not as a pattern', () => {
    expect(findInDocument([page('cost (est.) 5')], '(est.)').matches).toHaveLength(1);
    expect(findInDocument([page('cost est 5')], 'e.t').matches).toHaveLength(0);
  });

  it('finds nothing for a blank phrase', () => {
    expect(findInDocument(pages, '   ')).toEqual({ matches: [], more: false });
  });

  it('stops at the most it gives and says there are more', () => {
    const crowded = [page('x '.repeat(MOST_MATCHES + 5))];
    const { matches, more } = findInDocument(crowded, 'x');
    expect(matches).toHaveLength(MOST_MATCHES);
    expect(more).toBe(true);
  });

  it('steps through the matches and wraps round either way', () => {
    expect(stepMatch(null, 0)).toBeNull();
    expect(stepMatch(null, 3)).toBe(0);
    expect(stepMatch(null, 3, true)).toBe(2);
    expect(stepMatch(2, 3)).toBe(0);
    expect(stepMatch(0, 3, true)).toBe(2);
    expect(stepMatch(1, 3)).toBe(2);
  });
});

describe('zoom', () => {
  it('steps up and down the ladder, and stops at its ends', () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomIn(1.05)).toBe(1.1);
    expect(zoomOut(1)).toBe(0.9);
    expect(zoomOut(1.05)).toBe(1);
    expect(zoomIn(LARGEST_ZOOM)).toBe(LARGEST_ZOOM);
    expect(zoomOut(SMALLEST_ZOOM)).toBe(SMALLEST_ZOOM);
  });

  it('keeps a zoom within the ladder, and a zoom that is not a number at 100%', () => {
    expect(clampZoom(9)).toBe(LARGEST_ZOOM);
    expect(clampZoom(0.01)).toBe(SMALLEST_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('fits a page to the width it has, less a margin', () => {
    expect(fitWidthZoom({ available: 660, pageWidth: 612 })).toBeCloseTo(1);
    expect(fitWidthZoom({ available: 1000, pageWidth: 500, margin: 0 })).toBe(2);
    expect(fitWidthZoom({ available: 0, pageWidth: 612 })).toBe(1);
    expect(fitWidthZoom({ available: 800, pageWidth: 0 })).toBe(1);
  });

  it('says the zoom as a whole percentage', () => {
    expect(zoomLabel(1.25)).toBe('125%');
    expect(zoomLabel(0.67)).toBe('67%');
  });
});

describe('adding a PDF to the library', () => {
  it('takes a PDF by its name, refuses an empty one and one past the host’s size', () => {
    expect(checkIncomingDocument({ name: 'Brightwater.PDF', size: 10 }, 'pdf')).toEqual({
      kind: 'accepted',
    });
    expect(checkIncomingDocument({ name: 'notes.txt', size: 10 }, 'pdf')).toMatchObject({
      kind: 'refused',
      message: '“notes.txt” is not a PDF.',
    });
    expect(checkIncomingDocument({ name: 'a.pdf', size: 0 }, 'pdf')).toMatchObject({
      message: '“a.pdf” is empty.',
    });
    const refused = checkIncomingDocument({ name: 'big.pdf', size: MAX_DOCUMENT_BYTES + 1 }, 'pdf');
    expect(refused).toMatchObject({ kind: 'refused' });
    expect(refused.kind === 'refused' && refused.message).toContain('at most 32 MB');
    expect(checkIncomingDocument({ name: 'edge.pdf', size: MAX_DOCUMENT_BYTES }, 'pdf').kind).toBe(
      'accepted',
    );
  });

  it('knows a PDF by its header, even after a little junk before it', () => {
    expect(looksLikePdf(new TextEncoder().encode('%PDF-1.7\n'))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode(`${' '.repeat(500)}%PDF-1.4`))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode('<html>%PDF-'.padStart(1100, ' ')))).toBe(false);
    expect(looksLikePdf(new Uint8Array())).toBe(false);
  });

  it('names the copy after the file, safe for a link and for every filesystem', () => {
    expect(libraryFileName('The Lantern Keepers.pdf', 'pdf')).toBe('The Lantern Keepers.pdf');
    expect(libraryFileName('Notes #3 [draft] | v2.PDF', 'pdf')).toBe('Notes -3 -draft- - v2.pdf');
    expect(libraryFileName('a/b:c.pdf', 'pdf')).toBe('a b c.pdf');
    expect(libraryFileName('.pdf', 'pdf')).toBe('Untitled.pdf');
    expect(libraryFileName('report', 'pdf')).toBe('report.pdf');
  });

  it("titles the note by the PDF's own title when it names the work, else by the file", () => {
    const file = createVaultPath('Library/brightwater-scan.pdf');
    expect(
      literatureDetails({
        metadata: { title: ' The Lantern Keepers ', author: ' Mara Quill ' },
        file,
      }),
    ).toEqual({
      title: 'The Lantern Keepers',
      author: 'Mara Quill',
    });
    for (const placeholder of ['Untitled', 'Microsoft Word - draft.docx', 'scan.pdf', '  ', null]) {
      expect(literatureDetails({ metadata: { title: placeholder, author: '' }, file })).toEqual({
        title: 'brightwater-scan',
        author: null,
      });
    }
  });

  it("names an area's picture after the PDF and its page", () => {
    expect(
      areaImageName({ file: createVaultPath('Library/The Lantern Keepers.pdf'), page: 4 }),
    ).toBe('The Lantern Keepers p4 area.png');
  });

  it('tells a PDF by its name', () => {
    expect(isPdfName('a.pdf')).toBe(true);
    expect(isPdfName('a.PDF ')).toBe(true);
    expect(isPdfName('a.pdf.md')).toBe(false);
  });
});

describe('where opening a file goes', () => {
  it('opens a PDF in the reader and anything else as a note', () => {
    const pdf = createVaultPath('Library/The Lantern Keepers.pdf');
    const note = createVaultPath('Library/The Lantern Keepers.md');
    expect(placeOfFile(pdf)).toEqual({ kind: 'document', path: pdf });
    expect(placeOfFile(note)).toEqual({ kind: 'note', path: note });
  });
});

describe('the folder a PDF is added to', () => {
  it("is the literature type's home: Library, or the folder its type file names", () => {
    expect(libraryFolder({ types: [], today: '2026-10-22' })).toBe('Library');
    expect(
      libraryFolder({
        types: [{ name: 'literature', folder: 'Reading/{YYYY}' }],
        today: '2026-10-22',
      }),
    ).toBe('Reading/2026');
  });

  it('is Library still when the type file says the type has no home', () => {
    expect(
      libraryFolder({ types: [{ name: 'Literature', folder: ' ' }], today: '2026-10-22' }),
    ).toBe('Library');
  });
});
