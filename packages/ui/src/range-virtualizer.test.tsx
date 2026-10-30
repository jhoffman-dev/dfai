// @vitest-environment jsdom
/**
 * `useRangeVirtualizer` (#169, #626 review): draws again when the rows it
 * holds or the list's height change — at once during a scroll, in the next
 * render otherwise — and never for a scroll alone. The caller's own
 * `onChange` is still told. A row measured from its ref is drawn in the
 * next render rather than flushed from inside React's commit.
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { Rect, Virtualizer } from '@tanstack/react-virtual';
import { useRangeVirtualizer, type RangeVirtualizerOptions } from './range-virtualizer.ts';

const ROW = 20;

/** The scroller's observers, driven by hand: what a resize or a scroll would report. */
function observers() {
  const seen: {
    rect: ((rect: Rect) => void) | null;
    offset: ((offset: number, isScrolling: boolean) => void) | null;
  } = { rect: null, offset: null };
  return {
    seen,
    options: {
      observeElementRect: (_: Virtualizer<HTMLElement, Element>, cb: (rect: Rect) => void) => {
        seen.rect = cb;
        // Four and a half rows: a few pixels of scroll keep the same five rows in view.
        cb({ width: 200, height: 90 });
        return () => {};
      },
      observeElementOffset: (
        _: Virtualizer<HTMLElement, Element>,
        cb: (offset: number, isScrolling: boolean) => void,
      ) => {
        seen.offset = cb;
        return () => {};
      },
    },
  };
}

/** A list that counts its renders and shows the rows it holds. */
function List({
  options,
  onRender,
  measured = false,
}: {
  options: Partial<RangeVirtualizerOptions>;
  onRender: () => void;
  /** Whether each row is measured from its ref, as a list of rows of their own heights is. */
  measured?: boolean;
}) {
  const scroller = document.body;
  const virtualizer = useRangeVirtualizer({
    count: 500,
    getScrollElement: () => scroller,
    estimateSize: () => ROW,
    overscan: 0,
    ...options,
  });
  onRender();
  return (
    <div data-testid="rows">
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          data-start={item.start}
          ref={measured ? virtualizer.measureElement : undefined}
        >
          {item.index}
        </div>
      ))}
    </div>
  );
}

const shownRows = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-index]')].map((row) =>
    Number(row.getAttribute('data-index')),
  );

const startOf = (container: HTMLElement, index: number) =>
  Number(container.querySelector(`[data-index="${index}"]`)?.getAttribute('data-start'));

describe('useRangeVirtualizer', () => {
  it('draws again, outside a scroll, when the scroller grows to show more rows', () => {
    const { seen, options } = observers();
    const onRender = vi.fn();
    const { container } = render(<List options={options} onRender={onRender} />);
    expect(shownRows(container)).toHaveLength(5);
    const before = onRender.mock.calls.length;
    act(() => seen.rect?.({ width: 200, height: 190 }));
    expect(onRender.mock.calls.length).toBe(before + 1);
    expect(shownRows(container)).toHaveLength(10);
  });

  it('does not draw again for a scroll that starts and settles on the same rows', () => {
    const { seen, options } = observers();
    const onRender = vi.fn();
    render(<List options={options} onRender={onRender} />);
    const before = onRender.mock.calls.length;
    act(() => seen.offset?.(5, true));
    act(() => seen.offset?.(5, false));
    expect(onRender.mock.calls.length).toBe(before);
  });

  it('draws a scroll that brings new rows at once', () => {
    const { seen, options } = observers();
    const onRender = vi.fn();
    const { container } = render(<List options={options} onRender={onRender} />);
    act(() => seen.offset?.(100 * ROW, true));
    expect(shownRows(container)[0]).toBe(100);
  });

  it('tells the caller’s own onChange of every change, the scroll alone too', () => {
    const { seen, options } = observers();
    const onChange = vi.fn();
    render(<List options={{ ...options, onChange }} onRender={() => {}} />);
    onChange.mockClear();
    act(() => seen.offset?.(5, true));
    expect(onChange).toHaveBeenCalled();
  });

  it('draws again when a row measured from its ref is a new height, moving the rows below it', () => {
    const { seen, options } = observers();
    const { container } = render(
      <List
        options={{
          ...options,
          overscan: 3,
          // Below the screen, within the rows drawn past its edge: the range stays the same.
          measureElement: (row) => (row.getAttribute('data-index') === '14' ? 50 : ROW),
        }}
        onRender={() => {}}
        measured
      />,
    );
    // Row 14 comes in, and is measured, once the list has drawn.
    act(() => seen.offset?.(8 * ROW, false));
    expect(shownRows(container)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(startOf(container, 15)).toBe(14 * ROW + 50);
  });

  it('draws a row measured from its ref in the next render, never flushing inside React’s commit', () => {
    const { seen, options } = observers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { container } = render(
        <List
          options={{ ...options, overscan: 2, measureElement: () => 2 * ROW }}
          onRender={() => {}}
          measured
        />,
      );
      // Settled well down the list: the rows drawn above the screen grow as
      // they are measured, and the scroll is moved by as much (a sync change).
      act(() => seen.offset?.(100 * ROW, false));
      expect(shownRows(container)[0]).toBeGreaterThan(50);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('takes no lanes: in lanes a row can grow without the list growing, and go undrawn', () => {
    // Checked by the typecheck: passing `lanes` does not compile.
    expectTypeOf<RangeVirtualizerOptions>().not.toHaveProperty('lanes');
    expectTypeOf<RangeVirtualizerOptions>().toHaveProperty('count');
  });
});
