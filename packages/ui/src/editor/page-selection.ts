import type { EditorView } from '@tiptap/pm/view';

/**
 * The view's DOM observer. Not in prosemirror-view's types, but it is how the
 * view itself reads the page's selection (on every `selectionchange`), and
 * the tap-caret and block-anchor tests fail if it goes; a version without it
 * throws on the access, which is caught.
 */
interface ObservedView extends EditorView {
  domObserver: {
    flush: () => void;
    /** Where the observer last saw the page's selection; it reads only a change from it. */
    currentSelection: { clear: () => void };
  };
}

/** Reads the page's selection now, as the next `selectionchange` would. */
export function readPageSelection(view: EditorView): void {
  try {
    (view as ObservedView).domObserver.flush();
  } catch {
    // Safe to ignore: without the read (no observer, no flush, or a flush
    // that throws), ProseMirror's own check puts its selection back, exactly
    // as before the tap-caret extension.
  }
}

/** Makes the observer read the page's next selection, wherever it is. */
export function forgetPageSelection(view: EditorView): void {
  try {
    (view as ObservedView).domObserver.currentSelection.clear();
  } catch {
    // Safe to ignore: without the observer's record, the editor behaves as
    // before #877 (a caret put back on the spot last read is not read).
  }
}
