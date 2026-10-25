import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  DEFAULT_HIGHLIGHT_STYLE,
  literatureNoteText,
  MAX_NAME_BYTES,
  pdfPageText,
  quoteSelectorAt,
  utf8Bytes,
  type HighlightBlock,
  type PdfAnchor,
  type PdfPageText,
} from '@dfai/domain';
import { fakeOpenNotes } from '../testing/fake-ports.ts';
import {
  fakePdf,
  fakeReader,
  linesPage,
  memoryFiles,
  pdfBytes,
  readerMarkdown,
} from '../testing/fake-reader.ts';
import { addPdfToLibrary } from './add-pdf.ts';
import type { PickedDocument } from './library-copy.ts';
import { highlightArea } from './pdf-highlights.ts';
import { placeHighlights } from './place-highlights.ts';
import { linksToUpdate } from '../vault/update-links.ts';

/*
 * Regression tests for the PDF reader (#504, review of PR #515): re-anchoring, reading order,
 * the area picture's lifecycle, and Add PDF's names.
 */

const LIBRARY = createVaultPath('Library');
const BYTES = pdfBytes('the lantern keepers');

const picked = (name: string): PickedDocument => ({
  name,
  size: BYTES.length,
  bytes: async () => BYTES,
});

const blockOf = (id: string, anchor: PdfAnchor): HighlightBlock => ({
  id,
  quote: anchor.quote?.exact ?? '',
  comment: '',
  style: DEFAULT_HIGHLIGHT_STYLE,
  anchor,
  start: 0,
  markerEnd: 0,
  quoteEnd: 0,
  end: 0,
});

describe('re-anchoring when its own page has the words twice', () => {
  it('does not draw the highlight on another page as found exactly when its own page has the words', async () => {
    // Saved on page 2 from one edition; the copy downloaded again reworded the
    // passage round it, and page 2 now has "the tide bell" twice, page 1 once.
    const saved = linesPage('Old words. Ring the tide bell at noon, she said.');
    const start = saved.text.indexOf('the tide bell');
    const anchor: PdfAnchor = {
      kind: 'pdf',
      page: 2,
      quote: quoteSelectorAt({ text: saved.text, start, end: start + 'the tide bell'.length }),
      rects: [{ x: 0.2, y: 0.1, width: 0.13, height: 0.02 }],
    };
    const document = fakePdf([
      linesPage('Far away, someone rang the tide bell too.'),
      linesPage('First, the tide bell rang.', 'Then the tide bell stopped.'),
    ]);
    const [placed] = await placeHighlights({ opened: document, blocks: [blockOf('h1', anchor)] });
    // Page 2 is where it was made and its words are there: page 1's lone copy is not it.
    expect(placed?.placement).not.toMatchObject({ kind: 'words', page: 1 });
  });
});

describe('the highlights panel lists a two-column page in reading order', () => {
  it('puts the left column, read first, before the right column', async () => {
    // Two columns: the text runs down the left column, then down the right.
    const page: PdfPageText = pdfPageText([
      {
        text: 'Left top line.',
        box: { x: 0.05, y: 0.1, width: 0.4, height: 0.02 },
        endsLine: true,
      },
      {
        text: 'Left bottom line.',
        box: { x: 0.05, y: 0.8, width: 0.4, height: 0.02 },
        endsLine: true,
      },
      {
        text: 'Right top line.',
        box: { x: 0.55, y: 0.1, width: 0.4, height: 0.02 },
        endsLine: true,
      },
      {
        text: 'Right bottom line.',
        box: { x: 0.55, y: 0.8, width: 0.4, height: 0.02 },
        endsLine: false,
      },
    ]);
    const anchorFor = (words: string): PdfAnchor => {
      const at = page.text.indexOf(words);
      return {
        kind: 'pdf',
        page: 1,
        quote: quoteSelectorAt({ text: page.text, start: at, end: at + words.length }),
        rects: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.02 }],
      };
    };
    const placed = await placeHighlights({
      opened: fakePdf([page]),
      blocks: [
        blockOf('right-top', anchorFor('Right top line.')),
        blockOf('left-bottom', anchorFor('Left bottom line.')),
      ],
    });
    expect(placed.map((one) => one.block.id)).toEqual(['left-bottom', 'right-top']);
  });
});

const PDF = createVaultPath('Library/The Lantern Keepers.pdf');
const NOTE = createVaultPath('Library/The Lantern Keepers.md');
const SOURCE = literatureNoteText({
  kind: 'pdf',
  title: 'The Lantern Keepers',
  author: null,
  file: PDF,
});
const BOX = { x: 0.1, y: 0.4, width: 0.5, height: 0.3 };
const PICTURE = new Uint8Array([137, 80, 78, 71]);

function vault({ dirty = false, pdf = PDF } = {}) {
  const memory = memoryFiles({ [NOTE]: SOURCE, [pdf]: new Uint8Array([37]) });
  let draws = 0;
  const ports = {
    fs: memory.fs,
    markdown: readerMarkdown(),
    openNotes: fakeOpenNotes({ state: () => (dirty ? 'dirty' : 'closed') }),
    rng: { next: () => ((draws += 1) % 36) / 36 + 0.001 },
  };
  const area = (on = pdf) =>
    highlightArea(ports, {
      note: NOTE,
      pdf: on,
      page: 4,
      box: BOX,
      picture: async () => PICTURE,
      placement: 'attachments',
      style: DEFAULT_HIGHLIGHT_STYLE,
    });
  const pictures = () => [...memory.files.keys()].filter((path) => path.endsWith('.png'));
  return { ...memory, area, pictures };
}

describe("an area highlight's picture is saved only for a highlight that is added", () => {
  it('saves no picture when the note has unsaved typing and the highlight is refused', async () => {
    const { area, pictures } = vault({ dirty: true });
    await expect(area()).rejects.toThrow();
    expect(pictures()).toEqual([]);
  });

  it('saves no second picture when the same box is highlighted again and nothing is added', async () => {
    const { area, pictures, files } = vault();
    await area();
    const once = files.get(NOTE);
    const again = await area();
    expect(again.added).toBe(false);
    expect(files.get(NOTE)).toBe(once);
    expect(pictures()).toHaveLength(1);
  });

  it('highlights an area of a PDF whose name holds #, the vault being the person’s own', async () => {
    const pdf = createVaultPath('Papers/Field Notes #3.pdf');
    const { area, pictures } = vault({ pdf });
    const added = await area(pdf);
    expect(added.added).toBe(true);
    expect(pictures()).toHaveLength(1);
  });
});

describe('the literature note Add PDF makes is named so it can be made and linked', () => {
  it('names the note of a PDF titled with # [ ] | so a link can reach it', async () => {
    const { fs } = memoryFiles({ 'Library/.keep': '' });
    const document = fakePdf([linesPage('A light kept')], {
      title: 'Harbour Lights #2 [Revised] | Second Edition',
      author: 'Mara Quill',
    });
    const added = await addPdfToLibrary(
      { fs, reader: fakeReader(document) },
      { pdf: picked('harbour.pdf'), folder: LIBRARY },
    );
    expect(added.note).not.toMatch(/[#^|[\]]/);
  });

  it('names the note of a PDF whose title is longer than a file name may be', async () => {
    const { fs } = memoryFiles({ 'Library/.keep': '' });
    const document = fakePdf([linesPage('A light kept')], {
      title: 'On the Keeping of Lanterns along the Northern Channel, '.repeat(6).trim(),
      author: null,
    });
    const added = await addPdfToLibrary(
      { fs, reader: fakeReader(document) },
      { pdf: picked('lanterns.pdf'), folder: LIBRARY },
    );
    expect(utf8Bytes(added.note.split('/').at(-1) ?? '')).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });

  it('still adds a PDF whose document information cannot be read, titled by its name', async () => {
    const { fs, files } = memoryFiles({ 'Library/.keep': '' });
    const document = {
      ...fakePdf([linesPage('A light kept')]),
      metadata: async () => {
        throw new Error('Invalid Info dictionary');
      },
    };
    const added = await addPdfToLibrary(
      { fs, reader: fakeReader(document) },
      { pdf: picked('Brightwater Log.pdf'), folder: LIBRARY },
    );
    expect(added.title).toBe('Brightwater Log');
    expect(files.has('Library/Brightwater Log.md')).toBe(true);
  });
});

describe('a PDF moved in the vault keeps its literature note', () => {
  it("counts the note's file: link among the links a move of the PDF must re-point", async () => {
    const moved = createVaultPath('Archive/The Lantern Keepers.pdf');
    const { fs } = memoryFiles({ [NOTE]: SOURCE, [moved]: new Uint8Array([37]) });
    const found = await linksToUpdate({ fs, move: { from: PDF, to: moved }, notePaths: [NOTE] });
    expect(found.notes.map((note) => note.path)).toEqual([NOTE]);
  });
});
