import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  DEFAULT_HIGHLIGHT_STYLE,
  literatureNoteText,
  readHighlights,
  type HighlightBlock,
} from '@dfai/domain';
import { lineNoteBlocks } from '@dfai/domain/testing';
import { fakeOpenNotes } from '../testing/fake-ports.ts';
import { fakeBook, memoryFiles, readerMarkdown } from '../testing/fake-reader.ts';
import {
  allSectionTexts,
  highlightBookSelection,
  placeBookHighlights,
  searchBook,
} from './epub-highlights.ts';
import { NothingToHighlightError } from './pdf-highlights.ts';

/*
 * The EPUB reader's use-cases (#505): a stretch of a chapter highlighted
 * into the book's literature note with its CFI and words; the note's
 * highlights placed in the open book — where the CFI points, else by the
 * words, the other chapters read only when needed — and find in the book.
 */

const BOOK = createVaultPath('Library/fables.epub');
const NOTE = createVaultPath('Library/Fables of Brightwater.md');
const SOURCE = literatureNoteText({
  kind: 'epub',
  title: 'Fables of Brightwater',
  author: 'Mara Quill',
  file: BOOK,
});

const HARE =
  'The Hare and the Tortoise\n  A Hare one day ridiculed\n  the short feet.\nSlow but steady wins the race.';
const ANTS = 'The Ant and the Grasshopper\nWhen the winter came the Grasshopper had no food.';

/** The host's turn, as a test takes it: at once, counted. */
function countedPause() {
  const pause = async () => {
    pause.taken += 1;
  };
  pause.taken = 0;
  return pause;
}
const pause = countedPause();

function vault(text = SOURCE) {
  const memory = memoryFiles({ [NOTE]: text });
  let draws = 0;
  const ports = {
    fs: memory.fs,
    markdown: readerMarkdown(),
    openNotes: fakeOpenNotes(),
    rng: { next: () => ((draws += 1) % 36) / 36 + 0.001 },
  };
  return { ...memory, ports };
}

const range = (section: number, text: string, words: string) => {
  const start = text.indexOf(words);
  return { section, start, end: start + words.length };
};

describe('highlighting a stretch of a chapter', () => {
  it('adds a highlight anchored by the CFI of its trimmed words, and its words folded as they read', async () => {
    const { ports, files } = vault();
    const book = fakeBook([HARE, ANTS]);
    const picked = range(0, HARE, 'ridiculed\n  the short');
    const { id, added } = await highlightBookSelection(ports, {
      note: NOTE,
      book,
      selection: { ...picked, start: picked.start - 1, end: picked.end + 1 },
      style: { mark: 'underline', color: 'pink' },
      comment: 'Pride, before the fall.',
    });
    expect(added).toBe(true);
    const [block] = readHighlights(files.get(NOTE) as string, lineNoteBlocks);
    expect(block).toMatchObject({
      id,
      quote: 'ridiculed the short',
      comment: 'Pride, before the fall.',
      style: { mark: 'underline', color: 'pink' },
      anchor: {
        kind: 'epub',
        cfi: `epubcfi(/6/2!/${picked.start}:${picked.end})`,
        quote: { exact: 'ridiculed the short', suffix: ' feet. Slow but steady wins the ' },
      },
    });
  });

  it('adds the same passage once, answering the id it has', async () => {
    const { ports, files } = vault();
    const book = fakeBook([HARE]);
    const selection = range(0, HARE, 'Slow but steady');
    const first = await highlightBookSelection(ports, {
      note: NOTE,
      book,
      selection,
      style: DEFAULT_HIGHLIGHT_STYLE,
    });
    const again = await highlightBookSelection(ports, {
      note: NOTE,
      book,
      selection,
      style: DEFAULT_HIGHLIGHT_STYLE,
    });
    expect(again).toEqual({ id: first.id, added: false });
    expect(readHighlights(files.get(NOTE) as string, lineNoteBlocks)).toHaveLength(1);
  });

  it('refuses a selection of nothing but space, writing nothing', async () => {
    const { ports, files } = vault();
    const lineEnd = HARE.indexOf('\n');
    await expect(
      highlightBookSelection(ports, {
        note: NOTE,
        book: fakeBook([HARE]),
        selection: { section: 0, start: lineEnd, end: lineEnd + 3 },
        style: DEFAULT_HIGHLIGHT_STYLE,
      }),
    ).rejects.toThrow(NothingToHighlightError);
    expect(files.get(NOTE)).toBe(SOURCE);
  });
});

const block = (
  id: string,
  cfi: string,
  exact: string,
  prefix = '',
  suffix = '',
): HighlightBlock => ({
  id,
  quote: exact,
  comment: '',
  style: DEFAULT_HIGHLIGHT_STYLE,
  anchor: { kind: 'epub', cfi, quote: { exact, prefix, suffix } },
  start: 0,
  markerEnd: 0,
  quoteEnd: 0,
  end: 0,
});

describe("placing the note's highlights in the open book", () => {
  it('places each where its CFI points when the words there are its own, reading only those chapters', async () => {
    const book = fakeBook([HARE, ANTS]);
    const winter = range(1, ANTS, 'When the winter came');
    const slow = range(0, HARE, 'Slow but steady');
    const placed = await placeBookHighlights({
      book,
      pause,
      blocks: [
        block('w', `epubcfi(/6/4!/${winter.start}:${winter.end})`, 'When the winter came'),
        block('s', `epubcfi(/6/2!/${slow.start}:${slow.end})`, 'Slow but steady'),
      ],
    });
    expect(placed.map(({ block: each, placement }) => [each.id, placement])).toEqual([
      ['s', { kind: 'cfi', range: slow }],
      ['w', { kind: 'cfi', range: winter }],
    ]);
    expect([...new Set(book.textsRead)].sort()).toEqual([0, 1]);
  });

  it('finds by its words one whose CFI points at other words, in its own chapter first', async () => {
    const book = fakeBook([HARE, ANTS]);
    const [placed] = await placeBookHighlights({
      book,
      pause,
      blocks: [block('s', 'epubcfi(/6/2!/0:3)', 'Slow but steady')],
    });
    expect(placed?.placement).toEqual({ kind: 'words', range: range(0, HARE, 'Slow but steady') });
    expect(book.textsRead).toEqual([0]);
  });

  it('looks in every chapter for words its CFI no longer names, another edition’s CFI included', async () => {
    const book = fakeBook([HARE, ANTS]);
    const placed = await placeBookHighlights({
      book,
      pause,
      blocks: [
        block('elsewhere', 'epubcfi(/6/2!/0:3)', 'had no food'),
        block('foreign', 'epubcfi(/6/14[ch7]!/4/2/1:0)', 'the short feet'),
        block('gone', 'epubcfi(/6/2!/0:3)', 'A sentence this book never had'),
      ],
    });
    expect(Object.fromEntries(placed.map((each) => [each.block.id, each.placement]))).toEqual({
      elsewhere: { kind: 'words', range: range(1, ANTS, 'had no food') },
      foreign: { kind: 'words', range: range(0, HARE, 'the short feet') },
      gone: { kind: 'lost' },
    });
    expect(placed.at(-1)?.block.id).toBe('gone');
  });

  it('still places the others when a CFI cannot be read or a chapter cannot be read', async () => {
    const book = {
      ...fakeBook([HARE, ANTS]),
      placeOfCfi: async (cfi: string) => {
        if (cfi.includes('broken')) throw new Error('not a CFI');
        return { section: 1, range: null };
      },
      sectionText: async (section: number) => {
        if (section === 1) throw new Error('damaged');
        return HARE;
      },
    };
    const placed = await placeBookHighlights({
      book,
      pause,
      blocks: [
        block('a', 'epubcfi(broken)', 'Slow but steady'),
        block('b', 'epubcfi(/6/4!)', 'the short feet'),
      ],
    });
    expect(placed.map((each) => each.placement.kind)).toEqual(['words', 'words']);
  });

  it('leaves out highlights that are not an EPUB’s', async () => {
    const pdf: HighlightBlock = {
      ...block('p', 'epubcfi(/6/2!)', 'x'),
      anchor: { kind: 'pdf', page: 1, quote: { exact: 'x', prefix: '', suffix: '' }, rects: [] },
    };
    expect(await placeBookHighlights({ book: fakeBook([HARE]), blocks: [pdf], pause })).toEqual([]);
  });
});

describe('find in the book', () => {
  it('finds a phrase in every chapter, a chapter that cannot be read being one without words', async () => {
    const book = {
      ...fakeBook([HARE, ANTS, 'the grasshopper sang']),
      sectionText: async (section: number) => {
        if (section === 1) throw new Error('damaged');
        return [HARE, ANTS, 'the grasshopper sang'][section] as string;
      },
    };
    expect(await allSectionTexts(book, pause)).toEqual([HARE, '', 'the grasshopper sang']);
    const found = await searchBook(book, 'GRASSHOPPER', pause);
    expect(found).toEqual({ matches: [{ section: 2, start: 4, end: 15 }], more: false });
  });

  it("gives the window its turn between chapters, so a long book's find is many short tasks", async () => {
    const chapters = Array.from({ length: 40 }, (_, at) => `chapter ${at} of the long book`);
    const book = fakeBook(chapters);
    const between = countedPause();
    const order: string[] = [];
    const watched = {
      ...book,
      sectionText: async (section: number) => {
        order.push(`read ${section}`);
        return book.sectionText(section);
      },
    };
    const turn = async () => {
      order.push('turn');
      await between();
    };
    const found = await searchBook(watched, 'LONG book', turn);
    expect(found.matches).toHaveLength(40);
    expect(between.taken).toBe(39);
    // A turn between every two chapters read, none before the first.
    expect(order.slice(0, 5)).toEqual(['read 0', 'turn', 'read 1', 'turn', 'read 2']);
  });

  it('reads nothing of the book for a blank phrase', async () => {
    const book = fakeBook([HARE, ANTS]);
    expect(await searchBook(book, '   ', pause)).toEqual({ matches: [], more: false });
    expect(book.textsRead).toEqual([]);
  });
});
