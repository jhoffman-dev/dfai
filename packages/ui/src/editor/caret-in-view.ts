import { useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import { caretScrollBy, keyboardChange, keyboardInset, type Area } from '@dfai/domain';
import { scrollerOf } from '../scroller-of.ts';
import { hasCoarsePointer, onVisibleAreaChange, visibleArea } from '../visible-area.ts';

/** The CSS variable the note's bottom padding grows by while the keyboard is up (page.css). */
export const KEYBOARD_INSET_VARIABLE = '--keyboard-inset';

/**
 * Keeps the caret above the on-screen keyboard (#660). When the visible
 * area changes in the way a keyboard rising does — the domain's
 * `keyboardChange`, never on a desktop — the note is given the covered
 * height as room under its last line, and scrolled by whatever the domain
 * says puts the caret back in view; when the keyboard goes, the room is
 * taken back. Only wiring: which events, where the caret is, which element
 * scrolls, and one CSS variable. A desktop's window resizing, a pinch-zoom,
 * a pan: none of these is a keyboard, and nothing moves.
 *
 * `coarsePointer` is read from the media query; a test hands in its own.
 */
export function useCaretInView(
  editor: Editor | null,
  { coarsePointer = hasCoarsePointer() }: { coarsePointer?: boolean } = {},
): void {
  useEffect(() => {
    if (editor === null) return;
    let before = visibleArea();
    return onVisibleAreaChange(() => {
      const after = visibleArea();
      const change = keyboardChange({ before, after, coarsePointer });
      before = after;
      if (change === 'none') return;
      setKeyboardInset(keyboardInset({ windowHeight: window.innerHeight, visible: after }));
      if (change === 'rose') scrollCaretInto(editor, after);
    });
  }, [editor, coarsePointer]);
}

function setKeyboardInset(pixels: number): void {
  document.documentElement.style.setProperty(KEYBOARD_INSET_VARIABLE, `${pixels}px`);
}

/** Scrolls the note the caret is in — when it has the focus — so the caret is within `visible`. */
function scrollCaretInto(editor: Editor, visible: Area): void {
  if (editor.isDestroyed || !editor.view.hasFocus()) return;
  const caret = editor.view.coordsAtPos(editor.state.selection.head);
  const by = caretScrollBy({
    caret: { top: caret.top, left: caret.left, width: 0, height: caret.bottom - caret.top },
    visible,
  });
  if (by === 0) return;
  const scroller = scrollerOf(editor.view.dom);
  if (scroller === null) window.scrollBy({ top: by });
  else scroller.scrollBy({ top: by });
}
