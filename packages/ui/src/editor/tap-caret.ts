import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * ProseMirror's check after focus waits this long (prosemirror-view's
 * `handlers.focus`); the read below is queued with the same delay so it runs
 * just before that check, timers of equal delay running in the order set.
 */
const FOCUS_CHECK_MS = 20;

/**
 * A focus this soon after a press ends is still the press's, as with a tap's
 * synthesised mouse events; ProseMirror uses the same span for its own reads.
 */
const RELEASE_GRACE_MS = 300;

/** Ends a press wherever it is let go; a mouse can be released outside the editor. */
const PRESS_ENDS = ['mouseup', 'touchend', 'touchcancel'] as const;

/**
 * The view's DOM observer. Not in prosemirror-view's types, but it is how the
 * view itself reads the page's selection (on every `selectionchange`), and
 * the tap-caret test fails if it goes.
 */
interface ObservedView {
  domObserver?: { flush?: unknown };
}

/**
 * Keeps the caret a press put down when that press focused the editor (#835).
 *
 * On focus, ProseMirror waits 20 ms and, unless it has read the page's
 * selection by then, puts its own back. On a just-opened note its own is the
 * start, so when a busy main thread holds the tap's `selectionchange` past
 * 20 ms, the caret jumps there and the iPad keyboard scrolls to it. So, when
 * a press made the focus, the selection is read just before that check, the
 * same read the `selectionchange` would have made. Focus without a press —
 * Tab, a script's `focus()` — is left to ProseMirror as before.
 */
export const TapCaret = Extension.create({
  name: 'tapCaret',

  addProseMirrorPlugins() {
    return [tapCaretPlugin()];
  },
});

/**
 * A press counts from its start until it ends plus the grace, however long it
 * is held (an iOS long-press focuses ~500 ms in, with no mouse events), and
 * only for the focus it makes: one that starts with the editor already focused
 * makes none, and the focus it does make uses it up.
 */
function tapCaretPlugin(): Plugin {
  let held = false;
  let releasedAt = Number.NEGATIVE_INFINITY;
  const reads = new Set<ReturnType<typeof setTimeout>>();
  const start = (view: EditorView) => {
    if (!view.hasFocus()) held = true;
    return false;
  };
  const end = () => {
    if (held) releasedAt = Date.now();
    held = false;
  };
  const madeByPress = () => {
    const made = held || Date.now() - releasedAt <= RELEASE_GRACE_MS;
    held = false;
    releasedAt = Number.NEGATIVE_INFINITY;
    return made;
  };
  // Each focus keeps its own read: ProseMirror's check from an earlier focus
  // still runs, so cancelling that read on a quick refocus would lose the caret.
  const armRead = (view: EditorView) => {
    const read = setTimeout(() => {
      reads.delete(read);
      readPageSelection(view);
    }, FOCUS_CHECK_MS);
    reads.add(read);
  };
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown: start,
        touchstart: start,
        focus: (view) => {
          if (madeByPress()) armRead(view);
          return false;
        },
      },
    },
    view: (view) => {
      const doc = view.dom.ownerDocument;
      for (const type of PRESS_ENDS) doc.addEventListener(type, end, true);
      return {
        destroy: () => {
          for (const type of PRESS_ENDS) doc.removeEventListener(type, end, true);
          reads.forEach(clearTimeout);
          reads.clear();
        },
      };
    },
  });
}

function readPageSelection(view: EditorView): void {
  const observer = (view as ObservedView).domObserver;
  if (typeof observer?.flush !== 'function') return;
  try {
    observer.flush();
  } catch {
    // Safe to ignore: without the read, ProseMirror's own check puts its
    // selection back, exactly as before this extension.
  }
}
