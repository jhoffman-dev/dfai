import { useLayoutEffect, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type PartialKeys,
  type VirtualizerOptions,
} from '@tanstack/react-virtual';

/**
 * A virtualiser's options for an element scroller, its observers and scroll
 * filled in. Its rows are of a fixed height (`estimateSize`): nothing measures
 * them, so no change of size is reported from inside React's commit.
 */
export type RangeVirtualizerOptions = PartialKeys<
  VirtualizerOptions<HTMLElement, Element>,
  'observeElementRect' | 'observeElementOffset' | 'scrollToFn'
>;

/**
 * What a list draws from its virtualiser: the rows it holds — past the edge
 * too, and any its range extractor keeps — and how tall it is.
 */
function drawnBy(instance: Virtualizer<HTMLElement, Element>): string {
  const indexes = instance.getVirtualIndexes();
  return `${indexes.join(',')}:${instance.getTotalSize()}`;
}

/** The virtualiser, refusing to measure a row: its rows are of the height it estimates. */
function withoutMeasuring(
  instance: Virtualizer<HTMLElement, Element>,
): Virtualizer<HTMLElement, Element> {
  instance.measureElement = () => {
    throw new Error(
      'useRangeVirtualizer draws fixed-height rows: measureElement is not supported.',
    );
  };
  return instance;
}

/**
 * `useVirtualizer`, drawing again only when what it draws changes: the rows
 * it holds, or the list's height. `useVirtualizer` also draws as a scroll
 * starts and again as it settles (`isScrolling`), which a list that does not
 * read `isScrolling` pays for twice on every scroll — with the whole tree of
 * the component holding it, since rows sit absolutely in a full-height box
 * and a scroll within the drawn range moves nothing (#169). The caller's
 * own `onChange` is told of every change, as `useVirtualizer` tells it.
 *
 * Built on the same `Virtualizer`, and the same `_didMount` and `_willUpdate`
 * calls, as `useVirtualizer` in @tanstack/react-virtual 3.14.13, which
 * package.json pins exactly: those two are the library's internals, so an
 * upgrade is checked against its hook first.
 */
export function useRangeVirtualizer(
  options: RangeVirtualizerOptions,
): Virtualizer<HTMLElement, Element> {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const drawn = useRef<string | null>(null);
  const resolved: VirtualizerOptions<HTMLElement, Element> = {
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    ...options,
    onChange: (instance, sync) => {
      options.onChange?.(instance, sync);
      const now = drawnBy(instance);
      if (now === drawn.current) return;
      drawn.current = now;
      // During a scroll, drawn at once, so new rows are never a frame late.
      if (sync) flushSync(redraw);
      else redraw();
    },
  };
  const [instance] = useState(() => withoutMeasuring(new Virtualizer(resolved)));
  instance.setOptions(resolved);
  // What this render draws, kept once it is committed: a render thrown away draws nothing.
  const drawing = drawnBy(instance);
  useLayoutEffect(() => {
    drawn.current = drawing;
  });
  useLayoutEffect(() => instance._didMount(), [instance]);
  // Every render, as `useVirtualizer` does: the scroller may be another element now.
  useLayoutEffect(() => instance._willUpdate());
  return instance;
}
