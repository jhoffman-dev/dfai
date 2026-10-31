import { useCallback, useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { rowKeyOf } from '@dfai/domain';
import { focusIsHome, KEYS_HOME, type UndoLast } from '../row-keys.ts';

/**
 * The Inbox page as the keys' home (#109): once its last row has gone the
 * list is not drawn at all, so the page takes the focus the row had, and
 * U or ⌘Z there still takes the last clarification back — Inbox zero is when
 * it matters most. The row it brings back has the focus again (`stranded`,
 * `useInboxTriage`). Spread what it returns onto the page's element.
 */
export function useInboxHome({
  page,
  empty,
  busy,
  onUndo,
}: {
  page: RefObject<HTMLElement | null>;
  /** Whether the Inbox lists nothing now. */
  empty: boolean;
  /** While an undo is being written, so it is not asked for twice. */
  busy: boolean;
  onUndo?: UndoLast | undefined;
}) {
  const wasEmpty = useRef(empty);
  useEffect(() => {
    const emptied = empty && !wasEmpty.current;
    wasEmpty.current = empty;
    // Only a focus that went with the last row: one the person put elsewhere stays there.
    if (emptied && focusIsHome()) page.current?.focus();
  }, [empty, page]);
  const undoNow = useRef(onUndo);
  undoNow.current = onUndo;
  const idle = useRef(!busy);
  idle.current = !busy;
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    // Only on the page itself: a row, a field or an offer has keys of its own.
    if (event.target !== event.currentTarget) return;
    const key = rowKeyOf({
      key: event.key,
      mod: event.metaKey || event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
    });
    if (key !== 'undo') return;
    event.preventDefault();
    const takeBack = undoNow.current;
    // The app's undo waits for any clarification still being written (`takeBackLast`).
    if (event.repeat || !idle.current || takeBack === undefined) return;
    void takeBack();
  }, []);
  return { tabIndex: -1, ...KEYS_HOME, onKeyDown };
}
