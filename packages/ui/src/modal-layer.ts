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
 * The app's dialogs hold the layer through `./dialog.tsx`; the shell owns the
 * `inert`. The attribute is set and cleared as the count changes, not on a
 * render, so the app is inert before the popup's first focus and free again
 * before Base UI gives the focus back to what opened it.
 */
let held = 0;
const listeners = new Set<() => void>();

/** Marks one modal open until the returned release is called. */
export function holdModalLayer(): () => void {
  held += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held -= 1;
    notify();
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Keeps the element in `ref` inert while any modal is open over the app. */
export function useInertBehindModals(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const follow = () => element.toggleAttribute('inert', held > 0);
    follow();
    listeners.add(follow);
    return () => {
      listeners.delete(follow);
      element.removeAttribute('inert');
    };
  }, [ref]);
}
