import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  clampPan,
  clampZoom,
  fitZoom,
  panAfterZoom,
  zoomedByWheel,
  type Point,
} from './image-zoom.ts';

/*
 * What the image viewer shows (#568): the zoom (fit until one is chosen),
 * how far the image is panned, and the sizes fit is worked out from. The
 * image's own size is kept by its source, so stepping to another copy of
 * the same picture, which the webview does not load again, stays sized.
 */

const CENTRED: Point = { x: 0, y: 0 };

interface Extent {
  readonly width: number;
  readonly height: number;
}

const NO_SIZE: Extent = { width: 0, height: 0 };

export interface ZoomedView {
  readonly zoom: number;
  readonly fit: number;
  readonly pan: Point;
  /** The shown image's own size; no size until it has loaded. */
  readonly natural: Extent;
  /** Zooms to `zoom` (fit when null) about `anchor`, from the stage's centre. */
  set: (zoom: number | null, anchor?: Point) => void;
  panBy: (by: Point) => void;
  /** Back to fit and unpanned, for the next image. */
  reset: () => void;
  measureImage: (src: string, size: Extent) => void;
  measureRoom: (size: Extent) => void;
}

export function useZoomedView(src: string): ZoomedView {
  const [chosen, setChosen] = useState<number | null>(null);
  const [pan, setPan] = useState<Point>(CENTRED);
  const [sizes, setSizes] = useState<ReadonlyMap<string, Extent>>(new Map());
  const [room, setRoom] = useState<Extent>(NO_SIZE);
  const natural = sizes.get(src) ?? NO_SIZE;
  const fit = fitZoom({ image: natural, room });
  const zoom = chosen ?? fit;
  const drawnAt = (at: number) => ({ width: natural.width * at, height: natural.height * at });

  return {
    zoom,
    fit,
    pan,
    natural,
    set: (next, anchor) => {
      const to = next ?? fit;
      setChosen(next);
      // At fit or under it there is nothing to pan to.
      if (to <= fit) setPan(CENTRED);
      else
        setPan(
          clampPan({
            pan: panAfterZoom({ pan, from: zoom, to, anchor }),
            drawn: drawnAt(to),
            room,
          }),
        );
    },
    panBy: (by) =>
      setPan((at) =>
        clampPan({ pan: { x: at.x + by.x, y: at.y + by.y }, drawn: drawnAt(zoom), room }),
      ),
    reset: () => {
      setChosen(null);
      setPan(CENTRED);
    },
    measureImage: (measured, size) =>
      setSizes((known) =>
        known.get(measured) === undefined ? new Map(known).set(measured, size) : known,
      ),
    measureRoom: setRoom,
  };
}

/** The view as it is now, for listeners bound once. */
function useLatest<T>(value: T): RefObject<T> {
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  });
  return latest;
}

/** Where `event` is from the centre of `element`: what a zoom by the pointer keeps still. */
function fromCentre(element: HTMLElement, event: { clientX: number; clientY: number }): Point {
  const box = element.getBoundingClientRect();
  return {
    x: event.clientX - box.left - box.width / 2,
    y: event.clientY - box.top - box.height / 2,
  };
}

/**
 * Pinch and ⌘-scroll zoom, about the pointer. Bound by hand: React's wheel
 * listener is passive, so it cannot stop the page's own zoom.
 */
export function usePinchAndWheel(stage: RefObject<HTMLDivElement | null>, view: ZoomedView) {
  const latest = useLatest(view);
  useEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      // A trackpad pinch arrives as a wheel with the control key held.
      if (!(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      const now = latest.current;
      now.set(zoomedByWheel(now.zoom, event.deltaY), fromCentre(element, event));
    };
    // WebKit hands a pinch over as gesture events, with the scale since it began.
    let pinchedFrom = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      pinchedFrom = latest.current.zoom;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const { scale } = event as Event & { scale?: number };
      if (typeof scale === 'number')
        latest.current.set(clampZoom(pinchedFrom * scale, pinchedFrom));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('gesturestart', onGestureStart);
    element.addEventListener('gesturechange', onGestureChange);
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('gesturestart', onGestureStart);
      element.removeEventListener('gesturechange', onGestureChange);
    };
  }, [stage, latest]);
}

/** Measures the stage, which fit is worked out against, now and whenever the window changes. */
export function useRoomSize(stage: RefObject<HTMLDivElement | null>, view: ZoomedView) {
  const latest = useLatest(view);
  useEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const read = () =>
      latest.current.measureRoom({ width: element.clientWidth, height: element.clientHeight });
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [stage, latest]);
}
