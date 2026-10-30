import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import { rowAfterStep, rowKeyOf, type VaultPath } from '@dfai/domain';

/**
 * Where a key never fires (#307, #109): a field, where the letter is typed;
 * a dialog, a menu or a list box, which has the keyboard; anything editable.
 * A checkbox or a radio is pressed, not typed into, so a row's Done box —
 * Today's row handle — still takes the keys.
 */
const KEYS_SLEEP =
  'input:not([type="checkbox"]):not([type="radio"]), select, textarea, [role="dialog"], [role="menu"], [role="listbox"]';

/** Whether a key pressed on `target` is a letter being typed rather than a triage key. */
export function typesInto(target: Element): boolean {
  return (
    target.closest(KEYS_SLEEP) !== null ||
    (target instanceof HTMLElement && target.isContentEditable === true)
  );
}

/** The keys every triage page's rows answer to, listed before and after a page's own (#109). */
export const ROW_MOVE_HINTS = [
  ['J K', 'Move'],
  ['↵', 'Open'],
] as const;
export const ROW_UNDO_HINT = ['U', 'Undo'] as const;

/** What a press on these is the control's own: Return presses a button or follows a link. */
const PRESSED_BY_RETURN = 'button, a[href]';

/** The row an undo took back, and where the focus was as it was asked for. */
interface Returning {
  readonly path: VaultPath;
  readonly from: Element | null;
}

/** Takes the page's last change back; resolves to the row it took back, or null when it took none. */
export type UndoLast = () => Promise<VaultPath | null>;

/**
 * Gives the row an undo took back the focus, once the page lists it again —
 * unless the person has put the focus somewhere else since. Returns what
 * says which row that is.
 *
 * A row listed already as the undo settles is focused at once, and once more
 * on the page's next list: taken back, it is often listed somewhere else —
 * back from Chosen for today, say — and drawn anew there, its focus lost.
 */
function useFocusOnReturn(
  order: readonly VaultPath[],
  focusRow: (path: VaultPath) => void,
): (back: Returning) => void {
  const orderNow = useRef(order);
  orderNow.current = order;
  const returning = useRef<Returning | null>(null);
  const focusIfStill = useCallback(
    (back: Returning) => {
      const at = document.activeElement;
      if (at === back.from || at === null || at === document.body) focusRow(back.path);
    },
    [focusRow],
  );
  useEffect(() => {
    const back = returning.current;
    if (back === null || !order.includes(back.path)) return;
    returning.current = null;
    focusIfStill(back);
  }, [order, focusIfStill]);
  return useCallback(
    (back: Returning) => {
      if (!orderNow.current.includes(back.path)) {
        returning.current = back;
        return;
      }
      focusIfStill(back);
      returning.current = { path: back.path, from: document.activeElement };
    },
    [focusIfStill],
  );
}

/**
 * The keys every triage page's focused row answers to (#109): J, K and the
 * arrows move the focus a row, Return opens the row's note, U or ⌘Z takes
 * the page's last change back — and the row it took back, once listed
 * again, has the focus. The page keeps what a key does to the row itself.
 */
export function useRowKeys({
  order,
  focusRow,
  elementOf,
  onOpen,
  onUndo,
  undoWaits,
}: {
  /** Every row on the page, top to bottom. */
  order: readonly VaultPath[];
  /** Focuses a row, placing it first when the list has not drawn it. */
  focusRow: (path: VaultPath) => void;
  /** A row's element, when the list has drawn it. */
  elementOf: (path: VaultPath) => HTMLElement | undefined;
  onOpen: (path: VaultPath) => void;
  /** Left out, U does nothing. */
  onUndo?: UndoLast | undefined;
  /**
   * Whether a change is still on its way: the undo on offer is the one
   * before it until it lands, so U waits rather than take that back.
   */
  undoWaits: () => boolean;
}): (event: KeyboardEvent, path: VaultPath) => boolean {
  const orderNow = useRef(order);
  orderNow.current = order;
  const undoNow = useRef(onUndo);
  undoNow.current = onUndo;
  const focusOnReturn = useFocusOnReturn(order, focusRow);

  const move = useCallback(
    (from: VaultPath, step: 'next' | 'previous') => {
      const to = rowAfterStep({ order: orderNow.current, from, step });
      if (to === null) return;
      // A row the list has yet to draw takes the focus as it is drawn only
      // from the page, not from a control the person is on (`useRowHandles`).
      if (elementOf(to) === undefined && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      focusRow(to);
    },
    [elementOf, focusRow],
  );

  const undo = useCallback(() => {
    const takeBack = undoNow.current;
    if (takeBack === undefined || undoWaits()) return;
    const from = document.activeElement;
    // The page says an undo that failed itself, in its toast, and resolves null.
    void takeBack().then((path) => {
      if (path !== null) focusOnReturn({ path, from });
    });
  }, [undoWaits, focusOnReturn]);

  return useCallback(
    (event: KeyboardEvent, path: VaultPath) => {
      const key = rowKeyOf({
        key: event.key,
        mod: event.metaKey || event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
      });
      if (key === null) return false;
      if (key === 'open' && event.target instanceof Element) {
        if (event.target.closest(PRESSED_BY_RETURN) !== null) return false;
      }
      event.preventDefault();
      if (key === 'next' || key === 'previous') move(path, key);
      else if (event.repeat) return true;
      else if (key === 'open') onOpen(path);
      else undo();
      return true;
    },
    [move, onOpen, undo],
  );
}
