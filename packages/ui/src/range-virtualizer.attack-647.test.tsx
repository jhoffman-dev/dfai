// @vitest-environment jsdom
/**
 * Attack on PR #647: `useRangeVirtualizer` compares what the virtualiser
 * would draw now with what was drawn, but the "drawn" mark is only written in
 * the layout effect — after the rows' refs have measured in the same commit.
 * A render (from the caller) that draws a row at its estimate, measured in
 * that commit back to the size the previous commit drew, compares equal to
 * the previous commit and is never drawn again: the rows below sit where the
 * estimate put them.
 */
import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import type { Rect, Virtualizer } from '@tanstack/react-virtual';
import { useRangeVirtualizer } from './range-virtualizer.ts';

const ESTIMATE = 20;
const MEASURED = 50;

const options = {
  observeElementRect: (_: Virtualizer<HTMLElement, Element>, cb: (rect: Rect) => void) => {
    cb({ width: 200, height: 400 });
    return () => {};
  },
  observeElementOffset: () => () => {},
};

/** A list keyed by `keys`, every row measured from its ref at `MEASURED` px. */
function List({ keys }: { keys: readonly string[] }) {
  const virtualizer = useRangeVirtualizer({
    count: keys.length,
    getScrollElement: () => document.body,
    estimateSize: () => ESTIMATE,
    getItemKey: (index) => keys[index] ?? index,
    measureElement: () => MEASURED,
    overscan: 20,
    ...options,
  });
  return (
    <div data-testid="rows" data-total={virtualizer.getTotalSize()}>
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          data-start={item.start}
          ref={virtualizer.measureElement}
        />
      ))}
    </div>
  );
}

const startOf = (container: HTMLElement, index: number) =>
  Number(container.querySelector(`[data-index="${index}"]`)?.getAttribute('data-start'));

describe('useRangeVirtualizer — attack #647', () => {
  it('moves the rows below a row whose key changed at the same index, once it is measured', () => {
    const keys = Array.from({ length: 10 }, (_, at) => `k${at}`);
    const { container, rerender } = render(<List keys={keys} />);
    // Settled: every row measured, row 1 under row 0.
    expect(startOf(container, 1)).toBe(MEASURED);
    // Row 0 is another item now (an Inbox row decided as another is captured,
    // a Today task swapped): same count, a new key at index 0, same height.
    act(() => rerender(<List keys={['fresh', ...keys.slice(1)]} />));
    // Its ref measured it at 50 px in that commit; row 1 must start under it.
    expect(startOf(container, 1)).toBe(MEASURED);
  });
});
