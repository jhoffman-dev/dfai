import { useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import { caretScrollBy } from '@dfai/domain';
import { scrollerOf } from '../scroller-of.ts';
import { onVisibleAreaChange, visibleArea } from '../visible-area.ts';

/**
 * Keeps the caret above the on-screen keyboard (#660). When the visible
 * area changes — an iPad's keyboard rising, a pinch-zoom's pan — and the
 * editor has the focus, the note is scrolled by whatever the domain says
 * puts the caret back in view. Only wiring: which events, where the caret
 * is, and which element scrolls; how far is `caretScrollBy`'s to say. A
 * desktop's visible area changes only with its window, and then the caret
 * is where it was, so nothing is scrolled there.
 */
export function useCaretInView(editor: Editor | null): void {
  useEffect(() => {
    if (editor === null) return;
    return onVisibleAreaChange(() => {
      if (editor.isDestroyed || !editor.view.hasFocus()) return;
      const caret = editor.view.coordsAtPos(editor.state.selection.head);
      const by = caretScrollBy({
        caret: { top: caret.top, left: caret.left, width: 0, height: caret.bottom - caret.top },
        visible: visibleArea(),
      });
      if (by === 0) return;
      const scroller = scrollerOf(editor.view.dom);
      if (scroller === null) window.scrollBy({ top: by });
      else scroller.scrollBy({ top: by });
    });
  }, [editor]);
}
