import { useRef, type ReactNode } from 'react';
import type { BoardRow } from '@dfai/domain';
import {
  OVERSCAN,
  ROW_ESTIMATE,
  rowsPerPage,
  SCROLLER_ESTIMATE,
  Spacer,
  type LinePlace,
} from './grouped-rows.tsx';
import { useRowFocus } from './row-focus.ts';
import { useRangeVirtualizer } from './range-virtualizer.ts';

/**
 * A table's rows when it does not group them. Virtualised, as the grouped
 * rows are: only the rows near the scroller's window are in the page, so a
 * table of hundreds costs what a screenful does (#238), and spacers keep the
 * scrollbar true, so every row is reached by scrolling.
 *
 * Tab would leave the table at the last row drawn, so Up and Down move from a
 * row's name to the next row's, and Home and End to the first and last,
 * scrolling a row into the page first when it has not been drawn yet.
 */
export function FlatRows({
  rows,
  width,
  renderRow,
  scroller,
}: {
  rows: readonly BoardRow[];
  /** How many cells a row spans, its lead boxes included. */
  width: number;
  renderRow: (row: BoardRow, place: LinePlace) => ReactNode;
  /** The element the table scrolls in; null until it is in the page. */
  scroller: HTMLElement | null;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  const virtualizer = useRangeVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_ESTIMATE,
    overscan: OVERSCAN,
    initialRect: SCROLLER_ESTIMATE,
  });
  const onKeyDown = useRowFocus({
    body,
    count: rows.length,
    stopKey: (index) => rows[index]?.path ?? null,
    pageSize: () => rowsPerPage(scroller),
    scrollTo: (index) => virtualizer.scrollToIndex(index),
  });

  const items = virtualizer.getVirtualItems();
  const before = items[0]?.start ?? 0;
  const after = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);
  const measure = virtualizer.measureElement;

  return (
    <tbody ref={body} onKeyDown={onKeyDown}>
      {before > 0 && <Spacer height={before} width={width} />}
      {items.map((item) => {
        const row = rows[item.index];
        return row === undefined ? null : renderRow(row, { index: item.index, measure });
      })}
      {after > 0 && <Spacer height={after} width={width} />}
    </tbody>
  );
}
