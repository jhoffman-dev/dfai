// @vitest-environment jsdom
/**
 * `useRangeVirtualizer` (#169, #626 review): draws again when the rows it
 * holds or the list's height change — at once during a scroll, in the next
 * render otherwise — and never for a scroll alone. The caller's own
 * `onChange` is still told. Rows are of a fixed height: measuring one is
 * refused rather than flushed from inside React's commit.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
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
}: {
  options: Partial<RangeVirtualizerOptions>;
  onRender: () => void;
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
        <div key={item.key} data-index={item.index}>
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

  it('refuses to measure rows: it draws rows of a fixed height only', () => {
    const { options } = observers();
    const { result } = renderHook(() =>
      useRangeVirtualizer({
        count: 10,
        getScrollElement: () => document.body,
        estimateSize: () => ROW,
        ...options,
      }),
    );
    expect(() => result.current.measureElement(document.createElement('div'))).toThrow(
      /fixed-height rows/,
    );
  });
});
