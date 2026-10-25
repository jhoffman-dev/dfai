import {
  sectionTitle,
  type ContentsEntry,
  type HighlightColor,
  type HighlightPlacement,
} from '@dfai/domain';
import type { ReaderBookHighlight, ReaderHighlight } from './reader-types.ts';

/*
 * A highlight as the panel beside a reader lists it (#504, #505): its words,
 * its comment, where it is — a PDF's page, a book's chapter — and whether
 * that is exactly where it was made.
 */

export interface PanelEntry {
  readonly id: string;
  /** Its words as the note shows them, or what it is when it has none (an area of a page). */
  readonly quote: string;
  readonly comment: string;
  readonly color: HighlightColor;
  /** Where it is: `p. 3`, a chapter's title. */
  readonly place: string;
  /** What the entry says about where it is drawn, when that is not exactly where it was made. */
  readonly placeNote: string | null;
  /** Whether a click can bring it into view: false for one drawn nowhere. */
  readonly canShow: boolean;
}

/** A PDF's highlights as the panel lists them. */
export function pdfPanelEntries(highlights: readonly ReaderHighlight[]): PanelEntry[] {
  return highlights.map((highlight) => ({
    id: highlight.id,
    quote: highlight.placement.kind === 'area' ? 'Area of the page' : highlight.quote,
    comment: highlight.comment,
    color: highlight.style.color,
    place: pageLabel(highlight.placement),
    placeNote: pdfPlaceNote(highlight.placement),
    canShow: highlight.placement.kind !== 'lost',
  }));
}

function pageLabel(placement: HighlightPlacement): string {
  return placement.kind === 'lost' ? 'No page' : `p. ${placement.page}`;
}

function pdfPlaceNote(placement: HighlightPlacement): string | null {
  if (placement.kind === 'boxes') {
    return "Couldn't find the exact spot: shown where it was when it was made.";
  }
  if (placement.kind === 'lost') return "Couldn't find the exact spot in this file.";
  return null;
}

/** A book's highlights as the panel lists them, each placed by the chapter its contents call it. */
export function bookPanelEntries(
  highlights: readonly ReaderBookHighlight[],
  contents: readonly ContentsEntry[],
): PanelEntry[] {
  return highlights.map((highlight) => {
    const { placement } = highlight;
    const lost = placement.kind === 'lost';
    return {
      id: highlight.id,
      quote: highlight.quote,
      comment: highlight.comment,
      color: highlight.style.color,
      place: lost ? 'Not found' : sectionTitle({ section: placement.range.section, contents }),
      placeNote: lost ? "Couldn't find this passage in this book." : null,
      canShow: !lost,
    };
  });
}
