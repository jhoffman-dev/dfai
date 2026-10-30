import { useCallback, useEffect, useRef, type RefObject } from 'react';
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
  placeOf = NO_PLACE,
  settling = NONE_SETTLING,
  home,
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
  /** Where the page's read lists a row — its section and group — or null: a row moved there is drawn anew. */
  placeOf?: (path: VaultPath) => string | null;
  /** The rows acted on whose change the page has not read back. */
  settling?: ReadonlySet<VaultPath>;
  /** Where the focus goes when the last row leaves, so the page's keys still reach it (#109). */
  home?: RefObject<HTMLElement | null>;
}) {
  const { rowRef, focusRow: focusPlaced, wanted, elementOf } = useRowHandles(order);
  const pending = useRef<Pending | null>(null);
  const orderNow = useRef(order);
  orderNow.current = order;
  const placeNow = useRef(placeOf);
  placeNow.current = placeOf;

  /** Says a row is being acted on, before the action that may take it away. */
  const actedOn = useCallback(
    (path: VaultPath) => {
      pending.current = {
        acted: path,
        next: rowToFocusAfter({ order: orderNow.current, acted: path }),
        place: placeNow.current(path),
        hadFocus: elementOf(path)?.closest('tr')?.contains(document.activeElement) === true,
      };
    },
    [elementOf],
  );

  const focusRow = useCallback(
    (path: VaultPath | null) => {
      if (path !== null) focusPlaced(path);
      else home?.current?.focus();
    },
    [focusPlaced, home],
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
    // Seen settling, its change is read back once it no longer is.
    if (moved !== null && settling.has(moved.acted)) moved.seenSettling = true;
    if (moved === null || shown === null || busy) return;
    if (moved.refused === true) {
      focusIfBack(pending, orderNow.current, focusRow);
      return;
    }
    const readBack = moved.seenSettling === true && !settling.has(moved.acted);
    if (moved.handedTo !== undefined) {
      // Handed on already, it is kept only for a refusal, which brings the row and its focus back.
      if (readBack) pending.current = null;
      return;
    }
    // Asked of the read, never the DOM: a row scrolled out of it has not left.
    const stays = orderNow.current.includes(moved.acted);
    if (stays && placeNow.current(moved.acted) === moved.place) {
      // The index follows the file, so the page may be read again before the
      // row has left: it is waited for until its change is read back, and is
      // then not leaving — forgotten, so no later read moves the focus. A page
      // that says nothing of what settles keeps waiting for it to leave.
      if (!readBack) return;
      pending.current = null;
      // The row the keys were on is still there: a focus it lost meanwhile is given back.
      if (moved.hadFocus && !onAControl()) focusRow(moved.acted);
      return;
    }
    // Gone, or listed in another section — chosen for today, moved to a
    // status the page still lists — and so drawn anew there (#108): focus
    // went with the row it was on, to the document or to the panel around
    // it, which is where WebKit leaves it after a press on a button. On
    // another control, the person put it there since, and it is left alone.
    if (!onAControl()) focusRow(moved.next);
    // Handed on while its change may still be refused (#260): kept until it is read back.
    pending.current = readBack ? null : { ...moved, handedTo: document.activeElement };
  }, [shown, busy, settling, focusRow]);

  return { rowRef, actedOn, focusRow, wanted, elementOf };
}

/** A row acted on whose leaving, or staying, the page has yet to read. */
interface Pending {
  readonly acted: VaultPath;
  readonly next: VaultPath | null;
  /** Where the read listed it as it was acted on. */
  readonly place: string | null;
  /** Whether its row held the focus as it was acted on: from the keys, not the pointer. */
  readonly hadFocus: boolean;
  /** Its action was refused or failed, so the row comes back, and focus with it. */
  readonly refused?: boolean;
  /** The page has said its change is on its way: once it no longer does, the change is read back. */
  seenSettling?: boolean;
  /** Where its focus went on to, while its change may still be refused. */
  readonly handedTo?: Element | null;
}

const NO_PLACE = (): null => null;
const NONE_SETTLING: ReadonlySet<VaultPath> = new Set();

/** Whether the person has the focus on a control of their own. */
const onAControl = () => document.activeElement?.matches(CONTROLS) === true;

/**
 * A refused row, once it is back on the page, takes the focus it lost when it
 * was taken off — from the row it was handed on to, or from nowhere — unless
 * the person has put it on a control since. A row that never left still has
 * it, on its own control.
 */
function focusIfBack(
  pending: { current: Pending | null },
  order: readonly VaultPath[],
  focusRow: (path: VaultPath) => void,
): void {
  const moved = pending.current;
  if (moved === null || !order.includes(moved.acted)) return;
  pending.current = null;
  const stillHandedOn = moved.handedTo !== undefined && document.activeElement === moved.handedTo;
  if (stillHandedOn || !onAControl()) focusRow(moved.acted);
}
