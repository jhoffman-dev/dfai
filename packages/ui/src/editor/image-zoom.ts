/**
 * How far the image viewer is zoomed (#568): 1 is the image's own pixels.
 * Fit is the zoom that shows all of it in the window, never above 1, so a
 * small image is not blown up past its own pixels until it is zoomed.
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
  return clampZoom(Math.min(1, room.width / image.width, room.height / image.height));
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The next stop up from `zoom`. */
export function zoomedIn(zoom: number): number {
  return STOPS.find((stop) => stop > zoom + NEAR) ?? MAX_ZOOM;
}

/** The next stop down from `zoom`. */
export function zoomedOut(zoom: number): number {
  return [...STOPS].reverse().find((stop) => stop < zoom - NEAR) ?? MIN_ZOOM;
}

/** `zoom` after a pinch or a ⌘-scroll of `deltaY` pixels: up is in, as in Preview. */
export function zoomedByWheel(zoom: number, deltaY: number): number {
  return clampZoom(zoom * Math.exp(-deltaY / 200));
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
