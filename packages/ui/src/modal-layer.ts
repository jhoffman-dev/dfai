import { useLayoutEffect, type RefObject } from 'react';

/**
 * Which modals are open over the app, so the app can make itself inert behind
 * them (#827). Base UI hides the page outside a modal from assistive tech with
 * `aria-hidden`, but leaves it tabbable: its trap is a pair of focus guards
 * round the popup, which hold only once the focus is inside, and the popup
 * takes its first focus a frame after it opens. WebKit does not focus a
 * clicked button, so until then the focus is on the body and Tab walked the
 * sidebar and the tab strip behind the dialog. (Nor does Base UI's
 * `aria-hidden` reach the whole app: it spares the ancestors of every
 * `aria-live` region, so it cannot be mirrored onto `inert` either.)
 *
 * Each of the app's modal dialogs gives its portal `ref={holdModalLayer}`;
 * the shell owns the `inert`. The attribute is set and cleared as the count changes, not on a
 * render, so the app is inert before the popup's first focus and free again
 * before Base UI gives the focus back to what opened it.
 */
let held = 0;
const listeners = new Set<() => void>();

/**
 * A modal dialog's portal ref: the layer is held while the portal is in the
 * page (its dialog open or closing) and let go as it leaves, in React's commit.
 * A ref rather than a wrapper component, so a dialog renders nothing more for
 * it (the work budgets count every render). Not for a portal drawn inside the
 * app (the peek's, over its pane): making the app inert would make it inert too.
 */
export function holdModalLayer(portal: HTMLElement | null): (() => void) | undefined {
  if (portal === null) return undefined;
  held += 1;
  notify();
  return () => {
    held -= 1;
    notify();
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Keeps the element in `ref` inert while any modal is open over the app.
 *
 * WebKit drops the selection inside an element as it turns inert, so the caret
 * in a note would come back at the top when the focus returns to the editor.
 * The selection inside is kept as the app goes inert and put back as it is
 * freed, before Base UI returns the focus.
 */
export function useInertBehindModals(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    let kept: Range | null = null;
    const follow = () => {
      const inert = held > 0;
      if (inert === element.hasAttribute('inert')) return;
      if (inert) kept = rangeWithin(element);
      element.toggleAttribute('inert', inert);
      if (!inert && kept !== null) restoreRange(kept);
    };
    follow();
    listeners.add(follow);
    return () => {
      listeners.delete(follow);
      element.removeAttribute('inert');
    };
  }, [ref]);
}

function rangeWithin(element: HTMLElement): Range | null {
  const selection = element.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return element.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
}

function restoreRange(range: Range): void {
  const selection = range.startContainer.ownerDocument?.getSelection();
  if (selection === null || selection === undefined || !range.startContainer.isConnected) return;
  selection.removeAllRanges();
  selection.addRange(range);
}
