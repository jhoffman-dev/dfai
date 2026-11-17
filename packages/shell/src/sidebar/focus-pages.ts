/** How many frames to wait for Pages to be drawn, and the palette or drawer to settle, before giving up. */
const MOST_FRAMES = 60;
/** Frames the focus must stay on Pages before it counts as landed: a closing palette hands focus back once. */
const HELD_FRAMES = 3;

/** Pages' first row, or its heading when the tree has no row to focus or is shut. */
export function pagesFocusTarget(doc: Document): HTMLElement | null {
  return (
    doc.querySelector<HTMLElement>('#sidebar-userSpace [role="tree"] [tabindex="0"]') ??
    doc.querySelector<HTMLElement>('[aria-controls="sidebar-userSpace"]')
  );
}

/**
 * Puts the focus on Pages once it is drawn (#902): after ⌘K's Show Pages, the
 * section mounts a frame or two later, and the palette's own close hands the
 * focus back to what opened it, so the focus is set, then held for a few
 * frames, then left alone. Gives up quietly if Pages never appears.
 */
export function focusPagesWhenDrawn({
  doc = document,
  nextFrame = (run) => window.requestAnimationFrame(run),
}: {
  doc?: Document;
  nextFrame?: (run: () => void) => void;
} = {}): void {
  let frames = 0;
  let held = 0;
  const step = () => {
    frames += 1;
    const target = pagesFocusTarget(doc);
    const paletteGone = doc.querySelector('.palette') === null;
    if (target !== null && paletteGone) {
      if (doc.activeElement === target) held += 1;
      else target.focus();
    }
    if (held < HELD_FRAMES && frames < MOST_FRAMES) nextFrame(step);
  };
  nextFrame(step);
}
