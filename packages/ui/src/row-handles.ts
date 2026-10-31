import { useCallback, useEffect, useRef, useState } from 'react';
import type { VaultPath } from '@dfai/domain';

/** What a person focuses on purpose: something to press or type into. */
export const CONTROLS = 'button, input, select, textarea, a[href], [contenteditable="true"]';

/**
 * Each row's element in a virtualised list (#238), by path, and focusing a
 * row whether or not the list has put it in the DOM.
 *
 * A row that is not there is `wanted`: the list places it (its `pinned`
 * row), and it takes the focus as it is drawn — unless the person has put
 * the focus on a control of their own since. A wanted row that leaves the
 * list is forgotten, so it cannot take the focus if it is read again later
 * (#247).
 */
export function useRowHandles(order: readonly VaultPath[]) {
  const rows = useRef(new Map<VaultPath, HTMLElement>());
  const [wanted, setWanted] = useState<VaultPath | null>(null);
  const wantedNow = useRef<VaultPath | null>(null);
  // Current from the render, not from an effect: another hook's effect in the
  // commit that lists a row (an undo giving it back the focus) can run before
  // this one's, and would find the row not yet in the order and drop it.
  const orderNow = useRef(order);
  orderNow.current = order;
  useEffect(() => {
    if (wantedNow.current !== null && !order.includes(wantedNow.current)) {
      wantedNow.current = null;
      setWanted(null);
    }
  }, [order]);

  /** A row's handle: the element focus lands on when the row is focused. */
  const rowRef = useCallback(
    (path: VaultPath) => (element: HTMLElement | null) => {
      if (element === null) {
        rows.current.delete(path);
        return;
      }
      rows.current.set(path, element);
      if (wantedNow.current !== path) return;
      wantedNow.current = null;
      setWanted(null);
      if (document.activeElement?.matches(CONTROLS) !== true) element.focus();
    },
    [],
  );

  const focusRow = useCallback((path: VaultPath) => {
    const element = rows.current.get(path);
    if (element !== undefined) {
      element.focus();
      return;
    }
    if (!orderNow.current.includes(path)) return;
    wantedNow.current = path;
    setWanted(path);
  }, []);

  /** The element of a row in the DOM, if it is. */
  const elementOf = useCallback((path: VaultPath) => rows.current.get(path), []);

  return { rowRef, focusRow, wanted, elementOf };
}
