import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * ProseMirror's check after focus waits this long (prosemirror-view's
 * `handlers.focus`); the read below is queued with the same delay so it runs
 * just before that check, timers of equal delay running in the order set.
 */
const FOCUS_CHECK_MS = 20;

/** A press this recent made the focus; ProseMirror uses the same window for its own reads. */
const PRESS_FOCUS_MS = 300;

/**
 * The view's DOM observer. Not in prosemirror-view's types, but it is how the
 * view itself reads the page's selection (on every `selectionchange`), and
 * the tap-caret test fails if it goes.
 */
interface ObservedView {
  domObserver: { flush(): void };
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
    let pressedAt = Number.NEGATIVE_INFINITY;
    let read: ReturnType<typeof setTimeout> | undefined;
    const press = () => {
      pressedAt = Date.now();
      return false;
    };
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            mousedown: press,
            touchstart: press,
            focus: (view) => {
              if (Date.now() - pressedAt > PRESS_FOCUS_MS) return false;
              clearTimeout(read);
              read = setTimeout(() => readPageSelection(view), FOCUS_CHECK_MS);
              return false;
            },
          },
        },
        view: () => ({ destroy: () => clearTimeout(read) }),
      }),
    ];
  },
});

function readPageSelection(view: EditorView): void {
  if (view.isDestroyed) return;
  (view as unknown as ObservedView).domObserver.flush();
}
