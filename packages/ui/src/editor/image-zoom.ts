/**
 * How far the image viewer is zoomed (#568): 1 is the image's own pixels.
 * Fit is the zoom that shows all of it in the window, never above 1, so a
 * small image is not blown up past its own pixels until it is zoomed. Fit
 * may go below `MIN_ZOOM`, so any image fits; that limits only zooming out.
 */

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

/** The stops ⌘+ and ⌘− move between. */
const STOPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8] as const;

/** Close enough to count as the same zoom: a fit worked out from pixels is rarely a stop. */
const NEAR = 0.001;

interface Extent {
  readonly width: number;
  readonly height: number;
}

/** The zoom that shows all of `image` in `room`; 1 when either has no size yet. */
export function fitZoom({ image, room }: { image: Extent; room: Extent }): number {
  if (image.width <= 0 || image.height <= 0 || room.width <= 0 || room.height <= 0) return 1;
  return Math.min(1, room.width / image.width, room.height / image.height);
}

/** `zoom` held to the zooms there are; never below `from`, the zoom it came from, when that is lower. */
export function clampZoom(zoom: number, from = MIN_ZOOM): number {
  return Math.min(MAX_ZOOM, Math.max(Math.min(MIN_ZOOM, from), zoom));
}

/** The next stop up from `zoom`. */
export function zoomedIn(zoom: number): number {
  return STOPS.find((stop) => stop > zoom + NEAR) ?? MAX_ZOOM;
}

/** The next stop down from `zoom`. */
export function zoomedOut(zoom: number): number {
  return [...STOPS].reverse().find((stop) => stop < zoom - NEAR) ?? Math.min(zoom, MIN_ZOOM);
}

/** `zoom` after a pinch or a ⌘-scroll of `deltaY` pixels: up is in, as in Preview. */
export function zoomedByWheel(zoom: number, deltaY: number): number {
  return clampZoom(zoom * Math.exp(-deltaY / 200), zoom);
}

/** A double-click's zoom: fit from anywhere else; from fit, its own pixels, or twice them when it fits at those. */
export function toggledZoom(zoom: number, fit: number): number {
  if (Math.abs(zoom - fit) > NEAR) return fit;
  return fit < 1 - NEAR ? 1 : 2;
}

/** The zoom as the viewer says it: a whole percentage. */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The pan after zooming from `from` to `to` about `anchor` (from the stage's
 * centre): the point under the anchor stays under it, so the image does not
 * drift. Zooming from a key or a button is about the centre.
 */
export function panAfterZoom({
  pan,
  from,
  to,
  anchor = { x: 0, y: 0 },
}: {
  pan: Point;
  from: number;
  to: number;
  anchor?: Point | undefined;
}): Point {
  const ratio = from > 0 ? to / from : 1;
  return { x: anchor.x - (anchor.x - pan.x) * ratio, y: anchor.y - (anchor.y - pan.y) * ratio };
}

/** How much of a panned image always stays in the window, in pixels a side. */
const KEPT_ON_SCREEN = 48;

/** `pan` held so some of the image, drawn at `drawn`, stays in `room`. */
export function clampPan({ pan, drawn, room }: { pan: Point; drawn: Extent; room: Extent }): Point {
  const reach = (image: number, window: number) =>
    Math.max(0, (image + window) / 2 - Math.min(KEPT_ON_SCREEN, image));
  const within = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));
  return {
    x: within(pan.x, reach(drawn.width, room.width)),
    y: within(pan.y, reach(drawn.height, room.height)),
  };
}
