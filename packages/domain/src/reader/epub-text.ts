import type { EpubAnchor, HighlightStyle, TextQuoteSelector } from '../highlights/anchor.ts';
import type { NewHighlight } from '../highlights/edit-highlights.ts';
import { findQuote, findQuoteNear, quoteSelectorAt } from '../highlights/reanchor.ts';
import { findInTexts } from './find-in-document.ts';

/*
 * The EPUB reader's rules (#505, ADR-0043 §3 and §9). A book is read as one
 * text per chapter (its spine's sections), as the adapter gives it; a
 * selection is a stretch of one chapter's text, kept as the CFI the book
 * gives that stretch and its words with their surroundings. A stored
 * highlight is drawn where its CFI points when the words there are still its
 * own, else where its words are found — in the CFI's chapter first, then
 * outward — and nowhere, said so, when neither fits the book.
 */

/** A stretch of one chapter: `[start, end)` of section `section`'s text (from 0). */
export interface BookRange {
  readonly section: number;
  readonly start: number;
  readonly end: number;
}

/** Any run of space and line breaks, which a chapter's styles show as one space. */
const SPACES = /\s+/g;

/** `text` as it reads on screen: each run of space one space. */
export const foldedText = (text: string): string => text.replace(SPACES, ' ');

/**
 * The selection with the space at either end left out and its ends put in
 * order on the chapter's text; null when nothing but space is left.
 */
export function trimmedBookRange(range: BookRange, text: string): BookRange | null {
  const [from, to] = [clamp(range.start, text.length), clamp(range.end, text.length)];
  let start = Math.min(from, to);
  let end = Math.max(from, to);
  while (start < end && /\s/.test(text[start] as string)) start += 1;
  while (end > start && /\s/.test(text[end - 1] as string)) end -= 1;
  return start === end ? null : { section: range.section, start, end };
}

const clamp = (offset: number, length: number): number =>
  Number.isFinite(offset) ? Math.min(Math.max(Math.round(offset), 0), length) : 0;

/**
 * The selector of `[start, end)` of a chapter's text. A chapter's file
 * breaks its lines where it was wrapped and indents as its markup does, and
 * the screen shows every run of that as one space; so the selector keeps
 * the words as they read, folded the same way, and `findQuote` compares
 * spaces loosely either way.
 */
export function bookQuoteAt(range: BookRange, text: string): TextQuoteSelector {
  const raw = quoteSelectorAt({ text, start: range.start, end: range.end });
  return {
    exact: foldedText(raw.exact),
    prefix: foldedText(raw.prefix),
    suffix: foldedText(raw.suffix),
  };
}

/** The highlight of a stretch of a chapter whose CFI is `cfi` and whose words are `quote`. */
export function epubHighlight({
  cfi,
  quote,
  style,
  comment,
}: {
  cfi: string;
  quote: TextQuoteSelector;
  style: HighlightStyle;
  comment?: string;
}): NewHighlight {
  return {
    quote: quote.exact,
    anchor: { kind: 'epub', cfi, quote },
    style,
    ...(comment !== undefined && { comment }),
  };
}

/** Where an EPUB highlight is drawn in the open book. */
export type BookPlacement =
  /** Where its CFI points: the words there are its own. */
  | { readonly kind: 'cfi'; readonly range: BookRange }
  /** Found again by its words, its CFI pointing elsewhere or nowhere: another edition, or a file changed. */
  | { readonly kind: 'words'; readonly range: BookRange }
  /** Its words are not in the book: drawn nowhere. */
  | { readonly kind: 'lost' };

/** Where a CFI points in the open book: its chapter, and the stretch of it when the book has one there. */
export interface CfiPlace {
  readonly section: number;
  readonly range: BookRange | null;
}

/**
 * The highlight in the chapter its CFI names (`atCfi`, whose text is
 * `text`): where the CFI points when the words there are the highlight's,
 * else its words found in that chapter. Null when they are not there, so
 * the other chapters are read to look further.
 */
export function placeInCfiSection({
  anchor,
  atCfi,
  text,
}: {
  anchor: EpubAnchor;
  atCfi: CfiPlace;
  text: string;
}): BookPlacement | null {
  const range = atCfi.range;
  if (range !== null && sameWords(text.slice(range.start, range.end), anchor.quote.exact)) {
    return { kind: 'cfi', range };
  }
  const match = findQuote(text, anchor.quote);
  return match === null
    ? null
    : { kind: 'words', range: { section: atCfi.section, start: match.start, end: match.end } };
}

/** Whether two stretches of text are the same words, space compared loosely. */
const sameWords = (a: string, b: string): boolean => {
  const words = foldedText(b).trim();
  return words !== '' && foldedText(a).trim() === words;
};

/**
 * The highlight's words anywhere in the book, nearest the chapter its CFI
 * named (`near`, the first when it named none) first; lost when they are
 * nowhere.
 */
export function placeByBookWords({
  anchor,
  near,
  sections,
}: {
  anchor: EpubAnchor;
  near: number;
  sections: readonly string[];
}): BookPlacement {
  if (sections.length === 0) return { kind: 'lost' };
  const match = findQuoteNear({ sections, selector: anchor.quote, near });
  if (match === null) return { kind: 'lost' };
  return {
    kind: 'words',
    range: { section: match.section, start: match.start, end: match.end },
  };
}

/**
 * Highlights in the order they come in the book: by chapter, then by where
 * their words begin; one drawn nowhere after the rest. Stable, so two at one
 * spot keep the note's order.
 */
export function inBookOrder<T extends { readonly placement: BookPlacement }>(
  placed: readonly T[],
): T[] {
  return [...placed].sort((a, b) => {
    if (a.placement.kind === 'lost' || b.placement.kind === 'lost') {
      return Number(a.placement.kind === 'lost') - Number(b.placement.kind === 'lost');
    }
    const [first, second] = [a.placement.range, b.placement.range];
    return first.section - second.section || first.start - second.start;
  });
}

/** Every place `phrase` is in the book's chapters, in order, up to `MOST_MATCHES`. */
export function findInBook(
  sections: readonly string[],
  phrase: string,
): { matches: BookRange[]; more: boolean } {
  const found = findInTexts(sections, phrase);
  return {
    matches: found.matches.map(({ index, start, end }) => ({ section: index, start, end })),
    more: found.more,
  };
}

/** An entry of a book's table of contents, where the book resolved it to a chapter. */
export interface ContentsEntry {
  readonly title: string;
  /** The chapter it goes to (from 0), or null when its link names none the book has. */
  readonly section: number | null;
  readonly children: readonly ContentsEntry[];
}

/**
 * What chapter `section` is called, as a reader names a place in a book:
 * the title of the last contents entry at or before it, in the contents'
 * own order, else its place in the book (`Part 3`).
 */
export function sectionTitle({
  section,
  contents,
}: {
  section: number;
  contents: readonly ContentsEntry[];
}): string {
  let best: { title: string; section: number } | null = null;
  for (const entry of flattened(contents)) {
    if (entry.section === null || entry.section > section) continue;
    if (best === null || entry.section >= best.section) {
      best = { title: entry.title, section: entry.section };
    }
  }
  const title = best?.title.trim() ?? '';
  return title === '' ? `Part ${section + 1}` : title;
}

function* flattened(entries: readonly ContentsEntry[]): Generator<ContentsEntry> {
  for (const entry of entries) {
    yield entry;
    yield* flattened(entry.children);
  }
}
