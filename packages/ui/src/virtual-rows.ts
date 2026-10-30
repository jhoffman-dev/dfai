import { useCallback, useContext, useState, type FocusEvent, type RefObject } from 'react';
import { defaultRangeExtractor, type Range, type VirtualItem } from '@tanstack/react-virtual';
import { useRangeVirtualizer } from './range-virtualizer.ts';
import { RowScrollerContext, scrollerOf } from './row-scroller.ts';
import { useScrollMargin } from './scroll-margin.ts';

/** A row the list puts in the page, and the room left above it for the rows it does not. */
export interface PlacedRow {
  readonly key: string;
  readonly index: number;
  /** Height of the rows between this one and the one placed before it (or the list's top). */
  readonly gapBefore: number;
}

export interface VirtualRowsOptions {
  /** The element the rows start in, so they are placed below what sits above it. */
  readonly content: RefObject<HTMLElement | null>;
  /** Each row's key, top to bottom. */
  readonly keys: readonly string[];
  /** A row's height before it is measured. */
  readonly estimate: (index: number) => number;
  /**
   * The attribute a placed row carries its index in, which is how it is
   * measured and how focus inside it is traced back to it. Lists nested in
   * one another each need their own.
   */
  readonly indexAttribute?: string;
  /** Rows placed beyond each edge of what is shown. */
  readonly overscan?: number;
  /** A row to place wherever it is scrolled to: one the page is about to focus. */
  readonly pinned?: string | null;
  /**
   * Whether the first and last rows stay placed, for the keyboard to reach
   * from the list before or after. A list of lists leaves its own edges to
   * the virtualiser, which places the items nearest the screen.
   */
  readonly keepsEdges?: boolean;
}

export interface VirtualRows {
  readonly placed: readonly PlacedRow[];
  /** Height of the rows after the last one placed. */
  readonly after: number;
  /** For each placed row's element, carrying its index in `indexAttribute`: a row is placed by its own height. */
  readonly measure: (element: Element | null) => void;
  /** For the element around the rows: the row focus is in stays placed, with a row either side of it. */
  readonly onFocus: (event: FocusEvent<HTMLElement>) => void;
}

/**
 * A long list that puts in the page only the rows near what the scroller
 * shows, so a list of hundreds costs what a screenful does (#238).
 *
 * The row that has the focus is kept placed however far it is scrolled away,
 * and so are its neighbours: Tab and Shift+Tab move to the next row before
 * anything has scrolled, so every row can be reached from the keyboard
 * (#167). So are the list's first and last rows: Tab from the list before
 * this one, or Shift+Tab from the one after, lands on its edge row, where
 * the browser scrolls (#247). A row asked for by `pinned` is placed too, for
 * the page to focus; focusing it scrolls it into view.
 */
export function useVirtualRows({
  content,
  keys,
  estimate,
  indexAttribute = 'data-index',
  overscan = 12,
  pinned = null,
  keepsEdges = true,
}: VirtualRowsOptions): VirtualRows {
  const page = useContext(RowScrollerContext);
  const scroller = useCallback(() => scrollerOf(page, content), [page, content]);
  // A move above the list that its overscan covers waits for the next scroll:
  // half of what the overscan reaches at the smallest row, so what is placed
  // still runs past the screen's edge.
  const slack = (overscan * smallestOf(keys.length, estimate)) / 2;
  // Not anchored here: the virtualiser scrolls by as much as a placed row above the screen grows.
  const margin = useScrollMargin(content, scroller, { anchors: false, slack });
  const scrollMargin = margin ?? 0;
  const [focused, setFocused] = useState<string | null>(null);
  const held = [focused, pinned].map((key) => (key === null ? -1 : keys.indexOf(key)));
  const getItemKey = useCallback((index: number) => keys[index] ?? index, [keys]);
  const virtualizer = useRangeVirtualizer({
    count: keys.length,
    getScrollElement: scroller,
    estimateSize: estimate,
    getItemKey,
    overscan,
    indexAttribute,
    scrollMargin,
    // Starts from where the scroller already is: the virtualiser otherwise
    // scrolls it to 0 as it attaches, and lists mount while the page is scrolled.
    initialOffset: () => scroller()?.scrollTop ?? 0,
    rangeExtractor: (range: Range) =>
      withHeld({ indexes: defaultRangeExtractor(range), held, count: range.count, keepsEdges }),
    // jsdom reports a zero-height scroller, which would place no rows at all.
    initialRect: { width: 960, height: 880 },
  });
  // The page is scrolled by as much as a row wholly above the screen grows,
  // so what is shown stays put. Not before the list knows where it starts:
  // taken to start at 0, rows far down the page would seem above the screen,
  // and measuring them scrolled the page away from a focused row (#247). Set
  // while rendering, as the virtualiser's options are: the rows are measured
  // as they are attached, before any effect.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item: VirtualItem) =>
    margin !== null && item.end <= (virtualizer.scrollOffset ?? 0);

  const onFocus = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      const index = event.target.closest(`[${indexAttribute}]`)?.getAttribute(indexAttribute);
      const key = index === undefined || index === null ? undefined : keys[Number(index)];
      if (key !== undefined) setFocused(key);
    },
    [indexAttribute, keys],
  );

  const items = virtualizer.getVirtualItems();
  const placed: PlacedRow[] = [];
  let end = scrollMargin;
  for (const item of items) {
    placed.push({ key: String(item.key), index: item.index, gapBefore: item.start - end });
    end = item.end;
  }
  const after = virtualizer.getTotalSize() - (end - scrollMargin);
  return { placed, after, measure: virtualizer.measureElement, onFocus };
}

/** The range's rows, the list's first and last if kept, and each held row with the row either side of it. */
function withHeld({
  indexes,
  held,
  count,
  keepsEdges,
}: {
  indexes: number[];
  held: readonly number[];
  count: number;
  keepsEdges: boolean;
}): number[] {
  const wanted = new Set(indexes);
  if (keepsEdges && count > 0) wanted.add(0).add(count - 1);
  for (const index of held) {
    if (index < 0) continue;
    for (const near of [index - 1, index, index + 1]) {
      if (near >= 0 && near < count) wanted.add(near);
    }
  }
  return wanted.size === indexes.length ? indexes : [...wanted].sort((a, b) => a - b);
}

/** The smallest of `count` estimated heights; 0 for none. */
function smallestOf(count: number, estimate: (index: number) => number): number {
  let least = Number.POSITIVE_INFINITY;
  for (let at = 0; at < count; at += 1) least = Math.min(least, estimate(at));
  return count === 0 ? 0 : least;
}
