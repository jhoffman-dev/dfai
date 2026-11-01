/**
 * When a finger's press is a long press (#659).
 *
 * A touch screen has no hover and no right button, so a finger held still
 * stands in for both: it picks a card or a row up to drag, and it opens the
 * menu a right-click would. This is the one rule for how long a hold is and
 * how far the finger may drift meanwhile, so dragging, menus and their tests
 * agree on a number. A finger that moves further sooner is scrolling, and
 * the press is the page's again.
 */
export interface LongPressPolicy {
  /** How long the finger rests before the press is a long press, in milliseconds. */
  readonly holdMs: number;
  /** How far it may drift while it rests, in CSS pixels; further is a scroll. */
  readonly slopPx: number;
}

/**
 * 300ms is under the system's own long press (about half a second, which
 * brings up its callout), and 8px is a resting finger's wobble: a swipe to
 * scroll has left that behind in its first frames.
 */
export const LONG_PRESS: LongPressPolicy = Object.freeze({ holdMs: 300, slopPx: 8 });

/** Where a finger is at a moment: CSS pixels, and milliseconds on any one clock. */
export interface PressPoint {
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

/** Still held, held long enough, or moved off into a scroll. */
export type PressVerdict = 'pending' | 'long' | 'scrolled';

/**
 * What a press begun at `start` is at `now`. Drift is judged first: a finger
 * past the slop is scrolling however long it took, and nothing it does later
 * makes that a long press.
 */
export function judgePress(
  start: PressPoint,
  now: PressPoint,
  policy: LongPressPolicy = LONG_PRESS,
): PressVerdict {
  if (Math.hypot(now.x - start.x, now.y - start.y) > policy.slopPx) return 'scrolled';
  return now.at - start.at >= policy.holdMs ? 'long' : 'pending';
}

/** How much longer a press begun at `start` must be held from `nowMs`; none once it is due. */
export function holdRemaining(
  start: PressPoint,
  nowMs: number,
  policy: LongPressPolicy = LONG_PRESS,
): number {
  return Math.max(0, start.at + policy.holdMs - nowMs);
}
