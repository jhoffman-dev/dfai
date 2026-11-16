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
 * Each of the app's modal dialogs gives its portal `ref={holdModalLayer}`,
 * and the shell (`data-behind-modals`) makes itself inert while any is held.
 * The attribute is set and cleared as the count changes, not on a render, so
 * the app is inert before the popup's first focus and free again before Base
 * UI gives the focus back to what opened it.
 *
 * The count is module state, shared by every dialog in the window. That is
 * safe because React runs a ref's cleanup whenever its element leaves the
 * page — on close, on unmount, when an error tears the tree down, and between
 * StrictMode's double runs — so every hold is let go exactly once.
 */
let held = 0;
const listeners = new Set<() => void>();

/** What a shell marks itself with, so a portal drawn inside it is known. */
const BEHIND_MODALS = '[data-behind-modals]';
/** What stays live behind a modal: the toasts and the status, still announced. */
const STAYS_LIVE = '[data-stays-live]';

/**
 * A modal dialog's portal ref: the layer is held while the portal is in the
 * page (its dialog open or closing) and let go as it leaves, in React's commit.
 * A ref rather than a wrapper component, so a dialog renders nothing more for
 * it (the work budgets count every render). A portal given a `container`
 * inside the shell holds nothing, since making the app inert would make that
 * dialog inert too. No dialog in the app does that today (the peek takes a
 * `container`, but the app passes none); the check keeps the lint rule, which
 * asks every portal for this ref, from turning such a dialog inert.
 */
export function holdModalLayer(portal: HTMLElement | null): (() => void) | undefined {
  if (portal === null || portal.closest(BEHIND_MODALS) !== null) return undefined;
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
 * Keeps the element in `ref` inert while any modal is open over the app, all
 * but its regions marked `data-stays-live`, so a toast or the status raised
 * behind a dialog is still announced and can still be dismissed.
 *
 * WebKit drops the selection inside an element as it turns inert, so the caret
 * in a note would come back at the top when the focus returns to the editor.
 * The selection inside is kept as the app goes inert and put back as it is
 * freed, before Base UI returns the focus.
 */
export function useInertBehindModals(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = ref.current;
    if (root === null) return undefined;
    const made = new Set<Element>();
    let kept: Range | null = null;
    // What the app mounts while a modal is open (the drawer's way back, say)
    // is made inert as it comes. Only the children of the elements walked
    // matter, so each is watched without `subtree`.
    const mounts = new MutationObserver(() => makeInert());
    const makeInert = () => {
      mounts.disconnect();
      const live = [...root.querySelectorAll(STAYS_LIVE)];
      for (const element of outsideLive(root, live)) {
        element.setAttribute('inert', '');
        made.add(element);
      }
      for (const parent of walked(root, live)) mounts.observe(parent, { childList: true });
    };
    const free = () => {
      mounts.disconnect();
      for (const element of made) element.removeAttribute('inert');
      made.clear();
    };
    let inert = false;
    const follow = () => {
      if (inert === held > 0) return;
      inert = held > 0;
      if (inert) {
        kept = rangeWithin(root);
        makeInert();
        return;
      }
      free();
      if (kept !== null) restoreRange(kept);
    };
    follow();
    listeners.add(follow);
    return () => {
      listeners.delete(follow);
      free();
    };
  }, [ref]);
}

/** `root` and the elements down the way to each live region: those whose children are walked. */
function walked(root: Element, live: readonly Element[]): Element[] {
  const parents = [root];
  for (const child of root.children) {
    if (!live.includes(child) && live.some((region) => child.contains(region))) {
      parents.push(...walked(child, live));
    }
  }
  return parents;
}

/** The children of `root`, and down the way to each live region, that hold no live region. */
function outsideLive(root: Element, live: readonly Element[]): Element[] {
  const outside: Element[] = [];
  for (const child of root.children) {
    if (live.includes(child)) continue;
    if (live.some((region) => child.contains(region))) outside.push(...outsideLive(child, live));
    else outside.push(child);
  }
  return outside;
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
