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
 * filled in. One lane only, so no `lanes`: what is drawn is told by the rows
 * held and the list's height, and in lanes a row growing in the shorter lane
 * moves the rows under it without changing that height, so it would not be
 * drawn.
 */
export type RangeVirtualizerOptions = Omit<
  PartialKeys<
    VirtualizerOptions<HTMLElement, Element>,
    'observeElementRect' | 'observeElementOffset' | 'scrollToFn'
  >,
  'lanes'
>;

/**
 * What a list draws from its virtualiser: the rows it holds — past the edge
 * too, and any its range extractor keeps — and how tall it is. A measured row
 * that moves the rows below it changes how tall the list is, so it is drawn.
 */
function drawnBy(instance: Virtualizer<HTMLElement, Element>): string {
  const indexes = instance.getVirtualIndexes();
  return `${indexes.join(',')}:${instance.getTotalSize()}`;
}

/**
 * The virtualiser, noting while it measures a row from that row's ref: a
 * change of size found there is inside React's commit, where it cannot be
 * flushed, so it is drawn in the next render instead — as `useVirtualizer`
 * does.
 */
function withMeasuringNoted(
  instance: Virtualizer<HTMLElement, Element>,
  measuring: { current: boolean },
): Virtualizer<HTMLElement, Element> {
  const measureElement = instance.measureElement;
  instance.measureElement = (node) => {
    measuring.current = true;
    try {
      measureElement(node);
    } finally {
      measuring.current = false;
    }
  };
  return instance;
}

/**
 * `useVirtualizer`, drawing again only when what it draws changes: the rows
 * it holds, or the list's height. `useVirtualizer` also draws as a scroll
 * starts and again as it settles (`isScrolling`), which a list that does not
 * read `isScrolling` pays for twice on every scroll — with the whole tree of
 * the component holding it, since its rows sit in place in a list as tall
 * as all of them (absolutely, or between spacers) and a scroll within the
 * drawn range moves nothing (#169). The caller's own `onChange` is told of
 * every change, as `useVirtualizer` tells it. A list that reads where it is
 * scrolled to while it draws — the PDF reader's page number — is not drawn
 * for a scroll here, so it keeps `useVirtualizer`.
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
  const measuring = useRef(false);
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
      if (sync && !measuring.current) flushSync(redraw);
      else redraw();
    },
  };
  const [instance] = useState(() => withMeasuringNoted(new Virtualizer(resolved), measuring));
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
