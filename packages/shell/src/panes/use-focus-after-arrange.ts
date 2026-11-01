import { useEffect, useRef } from 'react';

/**
 * Somewhere in the focused pane a keyboard can carry on from: its editor, or
 * else the pane itself. Not a control in its bar: a pane that has just opened
 * draws its bar again once its note is read, and would drop the focus again.
 */
function focusedPaneTarget(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('.pane--focused [contenteditable="true"]') ??
    document.querySelector<HTMLElement>('.pane--focused')
  );
}

/**
 * Puts the focus back in the focused pane after a split or a close has taken
 * away the control that held it.
 *
 * Closing a pane removes its Close button, and a split removes the Split
 * button of the pane it split, so the focus falls to `<body>` — from the bar,
 * the "…" menu or the shortcut alike — and the keyboard has nowhere to go
 * from. Only then: focus that is still somewhere is where the person put it.
 * Not on the first render either, where nothing has been taken away.
 */
export function useFocusAfterArrange(paneCount: number): void {
  const counted = useRef(paneCount);
  useEffect(() => {
    if (counted.current === paneCount) return;
    counted.current = paneCount;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    focusedPaneTarget()?.focus();
  }, [paneCount]);
}
