import { useCallback, useEffect, useRef } from 'react';
import { rowToFocusAfter, type VaultPath } from '@dfai/domain';
import { CONTROLS, useRowHandles } from './row-handles.ts';

/**
 * Where focus is on the Today page, by row rather than by element (#111).
 *
 * Acting on a row usually takes it off the page, and the control that had
 * focus with it. So the page says which row was acted on, and once it shows
 * that the row has left, focus lands on the row the domain says comes next —
 * never back at the top of the document. A row that stays keeps its focus.
 * Keyboard triage (#109) moves through the same order with the same handle.
 *
 * The page puts only the rows near what it shows in the DOM (#238), so a row
 * to be focused may not be there: it is `wanted` (`useRowHandles`).
 */
export type RowFocus = ReturnType<typeof useRowFocus>;

export function useRowFocus({
  order,
  shown,
  problem,
  busy = false,
}: {
  /** Every row on the page, top to bottom. */
  order: readonly VaultPath[];
  /** Changes when the page shows a fresh read; null while it shows none — the index is being rebuilt, say. */
  shown: object | null;
  /** Why the last action could not be done, if it could not: nothing moved, so focus stays. */
  problem: string | null;
  /**
   * While an action is under way: every row's controls wait, and a control
   * that waits cannot take the focus. A row leaves at once (#260), so the next
   * row is focused once the action is done. Not busy unless said.
   */
  busy?: boolean;
}) {
  const { rowRef, focusRow: focusPlaced, wanted, elementOf } = useRowHandles(order);
  const pending = useRef<{
    acted: VaultPath;
    next: VaultPath | null;
    /** The row's handle as it was acted on: drawn anew elsewhere, the row has lost the focus. */
    handle: HTMLElement | undefined;
    /** Its action was refused or failed, so the row comes back, and focus with it. */
    refused?: boolean;
  } | null>(null);
  const orderNow = useRef(order);
  orderNow.current = order;
  // The row last acted on, which an undo brings back (#109).
  const lastActed = useRef<VaultPath | null>(null);

  /** Says a row is being acted on, before the action that may take it away. */
  const actedOn = useCallback(
    (path: VaultPath) => {
      lastActed.current = path;
      pending.current = {
        acted: path,
        next: rowToFocusAfter({ order: orderNow.current, acted: path }),
        handle: elementOf(path),
      };
    },
    [elementOf],
  );

  const focusRow = useCallback(
    (path: VaultPath | null) => {
      if (path !== null) focusPlaced(path);
    },
    [focusPlaced],
  );

  useEffect(() => {
    const moved = pending.current;
    if (problem === null || moved === null) return;
    // A row taken off at once is put back when its write is refused (#260).
    pending.current = { ...moved, refused: true };
    focusIfBack(pending, orderNow.current, focusRow);
  }, [problem, focusRow]);

  useEffect(() => {
    const moved = pending.current;
    if (moved === null || shown === null || busy) return;
    if (moved.refused === true) {
      focusIfBack(pending, orderNow.current, focusRow);
      return;
    }
    // The index follows the file, so the page may be read again before the
    // row has left: it is waited for, and a row that stays keeps its focus.
    // Asked of the read, not the DOM: a row scrolled out of it has not left.
    if (orderNow.current.includes(moved.acted)) {
      // Chosen for today, or moved to a status the page still lists, the row
      // is drawn anew in another section and its focus is lost with the old
      // one: it goes on to the next row, as it would had the row left (#108).
      if (moved.handle?.isConnected !== false || onAControl()) return;
      pending.current = null;
      focusRow(moved.next);
      return;
    }
    pending.current = null;
    // Focus went with the row — to the document, or to the panel around it,
    // which is where WebKit leaves it after a press on a button. On another
    // control, the person put it there since, and it is left alone.
    if (!onAControl()) focusRow(moved.next);
  }, [shown, busy, focusRow]);

  return {
    rowRef,
    actedOn,
    focusRow,
    wanted,
    elementOf,
    lastActed: useCallback(() => lastActed.current, []),
  };
}

/** Whether the person has the focus on a control of their own. */
const onAControl = () => document.activeElement?.matches(CONTROLS) === true;

/**
 * A refused row, once it is back on the page, takes the focus it lost when it
 * was taken off — unless the person has put it on a control since. A row
 * that never left still has it, on its own control.
 */
function focusIfBack(
  pending: { current: { acted: VaultPath; refused?: boolean } | null },
  order: readonly VaultPath[],
  focusRow: (path: VaultPath) => void,
): void {
  const moved = pending.current;
  if (moved === null || !order.includes(moved.acted)) return;
  pending.current = null;
  if (!onAControl()) focusRow(moved.acted);
}
