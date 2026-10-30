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

/** The undo a key asked for, and where the focus was then: the row taken back is focused once it is back. */
interface Returning {
  readonly path: VaultPath;
  readonly from: Element | null;
}

/**
 * The keys every triage page's focused row answers to (#109): J, K and the
 * arrows move the focus a row, Return opens the row's note, U or ⌘Z takes
 * the page's last change back — and the row it changed, once back, has the
 * focus again. The page keeps what a key does to the row itself.
 */
export function useRowKeys({
  order,
  focusRow,
  elementOf,
  onOpen,
  onUndo,
  lastActed,
}: {
  /** Every row on the page, top to bottom. */
  order: readonly VaultPath[];
  /** Focuses a row, placing it first when the list has not drawn it. */
  focusRow: (path: VaultPath) => void;
  /** A row's element, when the list has drawn it. */
  elementOf: (path: VaultPath) => HTMLElement | undefined;
  onOpen: (path: VaultPath) => void;
  /** Takes the page's last change back; left out, U does nothing. */
  onUndo?: (() => unknown) | undefined;
  /** The row the page's last change was made to, by a key or a control. */
  lastActed: () => VaultPath | null;
}): (event: KeyboardEvent, path: VaultPath) => boolean {
  const orderNow = useRef(order);
  orderNow.current = order;
  const undoNow = useRef(onUndo);
  undoNow.current = onUndo;
  const returning = useRef<Returning | null>(null);

  useEffect(() => {
    const back = returning.current;
    if (back === null || !order.includes(back.path)) return;
    returning.current = null;
    const at = document.activeElement;
    // Focus the person has put somewhere else since is left there.
    if (at === back.from || at === null || at === document.body) focusRow(back.path);
  }, [order, focusRow]);

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
      else undo(undoNow.current, lastActed(), returning);
      return true;
    },
    [move, onOpen, lastActed],
  );
}

function undo(
  onUndo: (() => unknown) | undefined,
  acted: VaultPath | null,
  returning: { current: Returning | null },
): void {
  if (onUndo === undefined) return;
  returning.current = acted === null ? null : { path: acted, from: document.activeElement };
  onUndo();
}
