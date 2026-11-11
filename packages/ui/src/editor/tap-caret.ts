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

/**
 * A press held longer than this no longer counts, so one whose end never
 * arrives cannot stick; an iOS long-press focuses ~500 ms in.
 */
const MAX_PRESS_MS = 2000;

/** Ends a press wherever it is let go; a mouse can be released outside the editor. */
const PRESS_ENDS = ['mouseup', 'touchend', 'touchcancel'] as const;

/** Ends a press with no end event to come: a drag swallows the mouseup. */
const PRESS_CANCELS = ['dragstart'] as const;

/**
 * The view's DOM observer. Not in prosemirror-view's types, but it is how the
 * view itself reads the page's selection (on every `selectionchange`), and
 * the tap-caret test fails if it goes; a version without it throws on the
 * read, which is caught.
 */
interface ObservedView extends EditorView {
  domObserver: { flush: () => void };
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
 * A press counts from its start until it ends plus the grace, held for up to
 * 2 s (an iOS long-press focuses ~500 ms in, with no mouse events), and only
 * for the focus it makes: one that starts with the editor already focused
 * makes none, and the focus it does make uses it up. A drag or the window
 * losing focus drops it, as no end will come.
 */
function tapCaretPlugin(): Plugin {
  let pressedAt = Number.NEGATIVE_INFINITY;
  let releasedAt = Number.NEGATIVE_INFINITY;
  const reads = new Set<ReturnType<typeof setTimeout>>();
  const held = () => Date.now() - pressedAt <= MAX_PRESS_MS;
  const start = (view: EditorView) => {
    if (!view.hasFocus()) pressedAt = Date.now();
    return false;
  };
  const cancel = () => {
    pressedAt = Number.NEGATIVE_INFINITY;
  };
  // Focus moving within the page is not the window losing it (jsdom fires
  // the window a blur then, with the newly focused element as relatedTarget).
  const leave = (event: FocusEvent) => {
    if (event.relatedTarget === null) cancel();
  };
  const end = () => {
    if (held()) releasedAt = Date.now();
    cancel();
  };
  const madeByPress = () => {
    const made = held() || Date.now() - releasedAt <= RELEASE_GRACE_MS;
    cancel();
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
      const win = doc.defaultView;
      for (const type of PRESS_ENDS) doc.addEventListener(type, end, true);
      for (const type of PRESS_CANCELS) doc.addEventListener(type, cancel, true);
      // Not captured: an element's blur would reach a capturing window listener too.
      win?.addEventListener('blur', leave);
      return {
        destroy: () => {
          for (const type of PRESS_ENDS) doc.removeEventListener(type, end, true);
          for (const type of PRESS_CANCELS) doc.removeEventListener(type, cancel, true);
          win?.removeEventListener('blur', leave);
          reads.forEach(clearTimeout);
          reads.clear();
        },
      };
    },
  });
}

function readPageSelection(view: EditorView): void {
  try {
    (view as ObservedView).domObserver.flush();
  } catch {
    // Safe to ignore: without the read (no observer, no flush, or a flush
    // that throws), ProseMirror's own check puts its selection back, exactly
    // as before this extension.
  }
}
