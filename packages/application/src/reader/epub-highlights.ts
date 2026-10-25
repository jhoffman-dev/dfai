import {
  bookQuoteAt,
  epubHighlight,
  findInBook,
  inBookOrder,
  placeByBookWords,
  placeInCfiSection,
  trimmedBookRange,
  type AppendedHighlight,
  type BookPlacement,
  type BookRange,
  type CfiPlace,
  type EpubAnchor,
  type HighlightBlock,
  type HighlightStyle,
  type VaultPath,
} from '@dfai/domain';
import {
  addHighlight,
  type LiteratureNoteWritePorts,
} from '../highlights/literature-note-writes.ts';
import type { Rng } from '../ports.ts';
import type { EpubBook, YieldToHost } from './epub-ports.ts';
import { NothingToHighlightError } from './pdf-highlights.ts';

/*
 * The EPUB reader's use-cases (#505, ADR-0043): a stretch of a chapter
 * highlighted, with its CFI and words, into the book's literature note; the
 * note's highlights placed in the open book — by CFI where the words there
 * are still the highlight's, else by its words, its own chapter's text read
 * first and every chapter's only when some are not there; and find in the
 * book.
 */

type BookText = Pick<EpubBook, 'sectionCount' | 'sectionText'>;

/** Adds a highlight of `selection`, a stretch of a chapter of `book`, to the note, and answers its id. */
export async function highlightBookSelection(
  ports: LiteratureNoteWritePorts & { readonly rng: Rng },
  {
    note,
    book,
    selection,
    style,
    comment,
  }: {
    note: VaultPath;
    book: Pick<EpubBook, 'sectionText' | 'cfiOf'>;
    selection: BookRange;
    style: HighlightStyle;
    comment?: string;
  },
): Promise<AppendedHighlight> {
  const text = await book.sectionText(selection.section);
  const range = trimmedBookRange(selection, text);
  if (range === null) throw new NothingToHighlightError();
  const highlight = epubHighlight({
    cfi: await book.cfiOf(range),
    quote: bookQuoteAt(range, text),
    style,
    ...(comment !== undefined && { comment }),
  });
  return addHighlight(ports, { path: note, highlight });
}

/** An EPUB highlight of the note, and where it is drawn in the open book. */
export interface PlacedBookHighlight {
  readonly block: HighlightBlock & { readonly anchor: EpubAnchor };
  readonly placement: BookPlacement;
}

type EpubBlock = PlacedBookHighlight['block'];

/** The note's EPUB highlights placed in `book`, in the order they come in it. */
export async function placeBookHighlights({
  book,
  blocks,
  pause,
}: {
  book: BookText & Pick<EpubBook, 'placeOfCfi'>;
  blocks: readonly HighlightBlock[];
  pause: YieldToHost;
}): Promise<PlacedBookHighlight[]> {
  const epubBlocks = blocks.filter((block): block is EpubBlock => block.anchor.kind === 'epub');
  const atCfi = await Promise.all(epubBlocks.map((block) => cfiPlaceOrNone(book, block.anchor)));
  const inOwn = await Promise.all(
    epubBlocks.map(async (block, at) => {
      const place = atCfi[at] ?? null;
      if (place === null) return null;
      const text = await sectionTextOrNone(book, place.section);
      return text === null ? null : placeInCfiSection({ anchor: block.anchor, atCfi: place, text });
    }),
  );
  const everySection = inOwn.includes(null) ? await allSectionTexts(book, pause) : [];
  const placed = epubBlocks.map((block, at) => ({
    block,
    placement:
      inOwn[at] ??
      placeByBookWords({
        anchor: block.anchor,
        near: atCfi[at]?.section ?? 0,
        sections: everySection,
      }),
  }));
  return inBookOrder(placed);
}

/** Where a CFI points, or null when it names nothing in this book or cannot be read. */
async function cfiPlaceOrNone(
  book: Pick<EpubBook, 'placeOfCfi'>,
  anchor: EpubAnchor,
): Promise<CfiPlace | null> {
  try {
    return await book.placeOfCfi(anchor.cfi);
  } catch {
    // A CFI another reader wrote, or one this edition has no place for, is a highlight found by its words.
    return null;
  }
}

async function sectionTextOrNone(book: BookText, section: number): Promise<string | null> {
  try {
    return await book.sectionText(section);
  } catch {
    // A chapter that cannot be read has no words to find: the highlight is looked for in the others.
    return null;
  }
}

/**
 * Every chapter's text, in order; one that cannot be read is a chapter
 * without words. The host's other work runs between chapters (`pause`).
 */
export async function allSectionTexts(book: BookText, pause: YieldToHost): Promise<string[]> {
  const texts: string[] = [];
  for (let section = 0; section < book.sectionCount; section += 1) {
    if (section > 0) await pause();
    texts.push((await sectionTextOrNone(book, section)) ?? '');
  }
  return texts;
}

/** Every place `phrase` is in the book (`findInBook`), read chapter by chapter with `pause` between. */
export async function searchBook(
  book: BookText,
  phrase: string,
  pause: YieldToHost,
): Promise<{ matches: BookRange[]; more: boolean }> {
  if (phrase.trim() === '') return { matches: [], more: false };
  return findInBook(await allSectionTexts(book, pause), phrase);
}
