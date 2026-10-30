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

/** Takes the page's last change back; resolves to the row it took back, or null when it took none. */
export type UndoLast = () => Promise<VaultPath | null>;

/**
 * Marks the element a page keeps the focus on when it has no row to hold it
 * — its last row gone (#109) — so U still reaches the page. Spread onto it
 * with `tabIndex={-1}`.
 */
export const KEYS_HOME = { 'data-keys-home': '' } as const;

/** Whether the focus is nowhere a person put it: on the document, or on the page's home. */
export function focusIsHome(at: Element | null = document.activeElement): boolean {
  return at === null || at === document.body || at.matches('[data-keys-home]');
}

/** An undo asked for from the keyboard, until its row has the focus or the person has moved on. */
interface Returning {
  /** The row the undo took back, once it says; null while it is being taken back. */
  path: VaultPath | null;
  /** Whether the row has been given the focus once. */
  focused: boolean;
  /** Lists read since the undo said, without its row. */
  misses: number;
  readonly release: () => void;
}

/** Lists read without the row taken back before it is given up on. */
const RETURN_LISTS = 3;

/**
 * Gives the row an undo took back the focus, once the page lists it — and
 * once more on the list after, since a row taken back is often listed
 * somewhere else, back from Chosen for today, say, and drawn anew there.
 * The person moving the focus at all since U gives it up, and so do a few
 * lists without the row, or the page going away. Returns the start of the
 * watch, at U, and its answer, once the undo says which row it took back.
 */
function useFocusOnReturn(
  order: readonly VaultPath[],
  focusRow: (path: VaultPath) => void,
): { begin: () => void; tookBack: (path: VaultPath | null) => void } {
  const orderNow = useRef(order);
  orderNow.current = order;
  const watch = useRef<Returning | null>(null);
  const ours = useRef(false);
  const stop = useCallback(() => {
    watch.current?.release();
    watch.current = null;
  }, []);
  /** Gives the row the focus, unless the person has it on something of their own. */
  const give = useCallback(
    (back: Returning, path: VaultPath) => {
      if (back.focused && !focusIsHome()) return;
      ours.current = true;
      try {
        focusRow(path);
      } finally {
        ours.current = false;
      }
      if (back.focused) stop();
      else back.focused = true;
    },
    [focusRow, stop],
  );
  useEffect(() => {
    const back = watch.current;
    if (back === null || back.path === null) return;
    if (order.includes(back.path)) give(back, back.path);
    else if ((back.misses += 1) >= RETURN_LISTS) stop();
  }, [order, give, stop]);
  useEffect(() => stop, [stop]);
  const begin = useCallback(() => {
    stop();
    const moved = () => {
      if (!ours.current) stop();
    };
    document.addEventListener('focusin', moved);
    watch.current = {
      path: null,
      focused: false,
      misses: 0,
      release: () => document.removeEventListener('focusin', moved),
    };
  }, [stop]);
  const tookBack = useCallback(
    (path: VaultPath | null) => {
      const back = watch.current;
      if (back === null) return;
      if (path === null) {
        stop();
        return;
      }
      back.path = path;
      if (orderNow.current.includes(path)) give(back, path);
    },
    [give, stop],
  );
  return { begin, tookBack };
}

/**
 * U or ⌘Z on a page (#109): takes the last change back, unless one is still
 * on its way — the undo on offer is the one before it until it lands — and
 * gives the row it took back the focus.
 */
export function useUndoKey({
  order,
  focusRow,
  onUndo,
  undoWaits,
}: {
  order: readonly VaultPath[];
  focusRow: (path: VaultPath) => void;
  onUndo?: UndoLast | undefined;
  undoWaits: () => boolean;
}): () => void {
  const undoNow = useRef(onUndo);
  undoNow.current = onUndo;
  const { begin, tookBack } = useFocusOnReturn(order, focusRow);
  return useCallback(() => {
    const takeBack = undoNow.current;
    if (takeBack === undefined || undoWaits()) return;
    begin();
    // The page says an undo that failed itself, in its toast, and resolves null.
    void takeBack().then(tookBack);
  }, [undoWaits, begin, tookBack]);
}

/**
 * The keys every triage page's focused row answers to (#109): J, K and the
 * arrows move the focus a row, Return opens the row's note, U or ⌘Z takes
 * the page's last change back (`useUndoKey`). With `path` null — the page's
 * home has the focus, its rows gone — only U is answered. The page keeps
 * what a key does to the row itself.
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
}): (event: KeyboardEvent, path: VaultPath | null) => boolean {
  const orderNow = useRef(order);
  orderNow.current = order;
  const undo = useUndoKey({ order, focusRow, onUndo, undoWaits });

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
    (event: KeyboardEvent, path: VaultPath | null) => {
      const key = rowKeyOf({
        key: event.key,
        mod: event.metaKey || event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
      });
      // With no row — the page's home has the focus — only U is the page's.
      if (key === null || (path === null && key !== 'undo')) return false;
      if (key === 'open' && event.target instanceof Element) {
        if (event.target.closest(PRESSED_BY_RETURN) !== null) return false;
      }
      event.preventDefault();
      if (event.repeat && key !== 'next' && key !== 'previous') return true;
      if (key === 'undo') undo();
      // A row's key always has its row: one with none was turned away above.
      else if (path !== null) {
        if (key === 'open') onOpen(path);
        else move(path, key);
      }
      return true;
    },
    [move, onOpen, undo],
  );
}
