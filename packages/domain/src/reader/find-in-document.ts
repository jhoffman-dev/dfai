import type { PageRect } from '../highlights/anchor.ts';
import { rectsForRange, type PdfPageText } from './pdf-page-text.ts';

/*
 * Find in a document (#504) or a book (#505): every place a phrase is, page
 * by page or chapter by chapter, in reading order. Letters are compared
 * without case and runs of space as one, since a PDF breaks lines where its
 * page ran out and an EPUB's lines are where its file was wrapped.
 */

/** One place the phrase was found. */
export interface DocumentMatch {
  /** From 1. */
  readonly page: number;
  readonly start: number;
  readonly end: number;
  readonly rects: readonly PageRect[];
}

/** The most matches one search gives; past it the search says there are more. */
export const MOST_MATCHES = 500;

/** Every place `phrase` is in `pages`, up to `MOST_MATCHES`; none for a blank phrase. */
export function findInDocument(
  pages: readonly PdfPageText[],
  phrase: string,
): { matches: DocumentMatch[]; more: boolean } {
  const found = findInTexts(
    pages.map((page) => page.text),
    phrase,
  );
  return {
    matches: found.matches.map(({ index, start, end }) => ({
      page: index + 1,
      start,
      end,
      rects: rectsForRange(pages[index] as PdfPageText, start, end),
    })),
    more: found.more,
  };
}

/** One place a phrase was found in a list of texts: `[start, end)` of text `index` (from 0). */
export interface TextMatch {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Every place `phrase` is in `texts` — a PDF's pages, an EPUB's chapters —
 * in order, up to `MOST_MATCHES`; none for a blank phrase.
 */
export function findInTexts(
  texts: readonly string[],
  phrase: string,
): { matches: TextMatch[]; more: boolean } {
  const pattern = phrasePattern(phrase);
  const matches: TextMatch[] = [];
  if (pattern === null) return { matches, more: false };
  for (const [index, text] of texts.entries()) {
    for (const found of text.matchAll(pattern)) {
      if (matches.length === MOST_MATCHES) return { matches, more: true };
      matches.push({ index, start: found.index, end: found.index + found[0].length });
    }
  }
  return { matches, more: false };
}

/** A pattern that matches the phrase's words in any case, any run of space between them. */
function phrasePattern(phrase: string): RegExp | null {
  const words = phrase
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return null;
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('\\s+'), 'giu');
}

/** The match after (or, going back, before) `current` in a list of `count`, wrapping round; null with none. */
export function stepMatch(current: number | null, count: number, back = false): number | null {
  if (count === 0) return null;
  if (current === null) return back ? count - 1 : 0;
  return (current + (back ? count - 1 : 1)) % count;
}
