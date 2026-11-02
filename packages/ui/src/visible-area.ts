import type { Area } from '@dfai/domain';

/**
 * The part of the page that can be seen, in client coordinates (#660).
 *
 * On an iPad the on-screen keyboard shrinks the browser's visual viewport
 * and leaves the window's size alone, and a pinch-zoom moves it; both are
 * `window.visualViewport`'s to report. Where the browser has none, the
 * window is all of it. This is only the reading: what to do with the
 * rectangle is the domain's (`placePopup`, `caretScrollBy`).
 */
export function visibleArea(): Area {
  const viewport = window.visualViewport;
  if (viewport === null || viewport === undefined) {
    return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
  }
  return {
    top: viewport.offsetTop,
    left: viewport.offsetLeft,
    width: viewport.width,
    height: viewport.height,
  };
}

/** Calls `listen` whenever the visible area changes size or place; returns what stops listening. */
export function onVisibleAreaChange(listen: () => void): () => void {
  const viewport = window.visualViewport;
  if (viewport === null || viewport === undefined) {
    window.addEventListener('resize', listen);
    return () => window.removeEventListener('resize', listen);
  }
  viewport.addEventListener('resize', listen);
  viewport.addEventListener('scroll', listen);
  return () => {
    viewport.removeEventListener('resize', listen);
    viewport.removeEventListener('scroll', listen);
  };
}
