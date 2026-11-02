/**
 * Keeping the caret and its popup in the part of the page that can be seen (#660).
 *
 * On an iPad the on-screen keyboard covers the lower half of the window
 * without the window knowing: the layout keeps its height, and only the
 * browser's visual viewport shrinks. A popup placed under the caret by the
 * window's edges then opens under the keyboard, and a caret the keyboard
 * rose over is typed into blind. These are the two rules for that: where a
 * popup goes so it is seen, and how far to scroll so the caret is. The
 * component that reads the visual viewport only hands its rectangle in.
 */

/** A rectangle in the page's client coordinates: what a bounding rect and the visual viewport both speak. */
export interface Area {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** Where a popup goes, and whether it had to open upward to be seen. */
export interface PopupPlacement {
  readonly top: number;
  readonly left: number;
  /** Above its anchor rather than below: there was no room under it. */
  readonly flipped: boolean;
  /** The height it is held to when neither side has room for all of it; null when one has. */
  readonly maxHeight: number | null;
}

/** The space between a popup and the caret it hangs from, in CSS pixels. */
export const POPUP_GAP = 6;

/**
 * Where a popup of `size` hangs from `anchor` (the caret's rectangle) so that
 * all of it is within `visible`. Under the anchor when it fits there, as a
 * popup always was; above it when only that side has room; and on the roomier
 * side, held to that room, when neither does. Sideways it is slid, never
 * flipped: a list reads from its left edge, so it keeps the caret's left
 * unless that would push it off the right edge.
 */
export function placePopup({
  anchor,
  size,
  visible,
  gap = POPUP_GAP,
}: {
  anchor: Area;
  size: { readonly width: number; readonly height: number };
  visible: Area;
  gap?: number;
}): PopupPlacement {
  const visibleBottom = visible.top + visible.height;
  // An anchor the keyboard has covered is judged from the visible edge it is
  // past, or the popup "above" it would open under the keyboard too.
  const anchorTop = clamp(anchor.top, visible.top, visibleBottom);
  const anchorBottom = clamp(anchor.top + anchor.height, visible.top, visibleBottom);
  const below = anchorBottom + gap;
  const roomBelow = visibleBottom - below;
  const roomAbove = anchorTop - gap - visible.top;
  const left = Math.max(
    visible.left,
    Math.min(anchor.left, visible.left + visible.width - size.width),
  );

  if (size.height <= roomBelow) return { top: below, left, flipped: false, maxHeight: null };
  if (size.height <= roomAbove) {
    return { top: anchorTop - gap - size.height, left, flipped: true, maxHeight: null };
  }
  if (roomAbove > roomBelow) {
    const maxHeight = Math.max(0, roomAbove);
    return { top: anchorTop - gap - maxHeight, left, flipped: true, maxHeight };
  }
  return { top: below, left, flipped: false, maxHeight: Math.max(0, roomBelow) };
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** How close to the visible edge a caret may sit before it is brought in, in CSS pixels. */
export const CARET_MARGIN = 8;

/**
 * How far to scroll, in CSS pixels, so the caret at `caret` sits within
 * `visible` with a margin to its edge: positive is down (the caret was under
 * the keyboard), negative up, zero when it is already in view.
 */
export function caretScrollBy({
  caret,
  visible,
  margin = CARET_MARGIN,
}: {
  caret: Area;
  visible: Area;
  margin?: number;
}): number {
  const visibleBottom = visible.top + visible.height;
  const caretBottom = caret.top + caret.height;
  if (caretBottom + margin > visibleBottom) return caretBottom + margin - visibleBottom;
  if (caret.top - margin < visible.top) return caret.top - margin - visible.top;
  return 0;
}

/** What a change of the visible area says about the on-screen keyboard. */
export type KeyboardChange = 'rose' | 'fell' | 'none';

/**
 * Whether a change of the visible area is the on-screen keyboard rising or
 * going: the height changed and the width did not, on a touch screen. A
 * window resized by a mouse, or a pinch-zoom, changes the width too — and
 * a desktop has no on-screen keyboard at all, so there the answer is never
 * a keyboard, and nothing of its own moves (review of PR #744).
 */
export function keyboardChange({
  before,
  after,
  coarsePointer,
}: {
  before: Area;
  after: Area;
  /** Whether the pointer is a finger: `(pointer: coarse)`. */
  coarsePointer: boolean;
}): KeyboardChange {
  if (!coarsePointer || after.width !== before.width || after.height === before.height)
    return 'none';
  return after.height < before.height ? 'rose' : 'fell';
}

/**
 * How much of the window the keyboard covers, in CSS pixels: the part below
 * the visible area. A note is given this much more room under its last line,
 * or the caret there could not be scrolled above the keyboard (review of
 * PR #744: below the last line there is only the note's own padding).
 */
export function keyboardInset({
  windowHeight,
  visible,
}: {
  windowHeight: number;
  visible: Area;
}): number {
  return Math.max(0, windowHeight - (visible.top + visible.height));
}
