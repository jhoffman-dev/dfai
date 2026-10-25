import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { Dialog } from '@base-ui/react/dialog';
import {
  clampZoom,
  fitZoom,
  toggledZoom,
  zoomedByWheel,
  zoomedIn,
  zoomedOut,
  zoomLabel,
} from './image-zoom.ts';

/** An image of the note, as the viewer is handed it. */
export interface LightboxImage {
  readonly src: string;
  readonly alt: string;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

const CENTRED: Point = { x: 0, y: 0 };

/**
 * A note's images, one at a time, as large as the window holds them (#568).
 * ⌘+ / ⌘− / ⌘0, pinch or ⌘-scroll zoom; a double-click goes between fit and
 * the image's own pixels; a drag pans a zoomed image; ← → step through the
 * note's images. Escape or a click beside the image closes it, and
 * `onReturnFocus` hands the focus back to the image it was opened from.
 */
export function ImageLightbox({
  images,
  start,
  loadImage,
  onClose,
  onReturnFocus,
}: {
  images: readonly LightboxImage[];
  start: number;
  loadImage: (src: string) => Promise<string | null>;
  onClose: () => void;
  onReturnFocus: () => void;
}) {
  const [index, setIndex] = useState(start);
  const image = images[index];
  const view = useZoomedView();
  const url = useLoadedUrl(image?.src ?? null, loadImage);

  const step = (by: number) => {
    const next = index + by;
    if (next < 0 || next >= images.length) return;
    setIndex(next);
    view.reset();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const handled = zoomKey(event, view) || stepKey(event, step);
    if (handled) event.preventDefault();
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="lightbox__backdrop" />
        <Dialog.Popup
          className="lightbox"
          onKeyDown={onKeyDown}
          finalFocus={() => {
            onReturnFocus();
            return false;
          }}
        >
          <Dialog.Title className="visually-hidden">
            {image?.alt !== undefined && image.alt !== '' ? image.alt : 'Image'}
          </Dialog.Title>
          <Stage url={url} alt={image?.alt ?? ''} view={view} onClose={onClose} />
          <ZoomBar view={view} count={images.length} index={index} onStep={step} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The image's url once it is loaded; null while it loads, or when it cannot be. */
function useLoadedUrl(
  src: string | null,
  loadImage: (src: string) => Promise<string | null>,
): string | null {
  const [loaded, setLoaded] = useState<{ src: string; url: string | null } | null>(null);
  useEffect(() => {
    if (src === null) return;
    let cancelled = false;
    loadImage(src)
      .then((url) => {
        if (!cancelled) setLoaded({ src, url });
      })
      .catch(() => {
        // Shown as "could not be shown", which is all a failure here can say.
        if (!cancelled) setLoaded({ src, url: null });
      });
    return () => {
      cancelled = true;
    };
  }, [src, loadImage]);
  return loaded !== null && loaded.src === src ? loaded.url : null;
}

/** What the viewer is showing: the zoom (null is fit), how far it is panned, and the sizes fit needs. */
interface ZoomedView {
  readonly zoom: number;
  readonly fit: number;
  readonly pan: Point;
  readonly natural: { width: number; height: number };
  set: (zoom: number | null) => void;
  panBy: (by: Point) => void;
  reset: () => void;
  measure: (sizes: {
    natural?: { width: number; height: number };
    room?: { width: number; height: number };
  }) => void;
}

function useZoomedView(): ZoomedView {
  const [chosen, setChosen] = useState<number | null>(null);
  const [pan, setPan] = useState<Point>(CENTRED);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const fit = fitZoom({ image: natural, room });
  const zoom = chosen ?? fit;
  return {
    zoom,
    fit,
    pan,
    natural,
    set: (next) => {
      setChosen(next);
      // Back at fit there is nothing to pan to.
      if (next === null || next <= fit) setPan(CENTRED);
    },
    panBy: (by) => setPan((at) => ({ x: at.x + by.x, y: at.y + by.y })),
    reset: () => {
      setChosen(null);
      setPan(CENTRED);
      setNatural({ width: 0, height: 0 });
    },
    measure: (sizes) => {
      if (sizes.natural !== undefined) setNatural(sizes.natural);
      if (sizes.room !== undefined) setRoom(sizes.room);
    },
  };
}

/** ⌘+ / ⌘= in, ⌘− out, ⌘0 back to fit. True when the key was one of them. */
function zoomKey(event: KeyboardEvent, view: ZoomedView): boolean {
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (event.key === '+' || event.key === '=') view.set(zoomedIn(view.zoom));
  else if (event.key === '-' || event.key === '_') view.set(zoomedOut(view.zoom));
  else if (event.key === '0') view.set(null);
  else return false;
  return true;
}

function stepKey(event: KeyboardEvent, step: (by: number) => void): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key === 'ArrowLeft') step(-1);
  else if (event.key === 'ArrowRight') step(1);
  else return false;
  return true;
}

/** Moves under a pointer that still count as a click rather than a pan. */
const CLICK_SLOP = 3;

/** The window the image is shown in: a click on it beside the image closes the viewer. */
function Stage({
  url,
  alt,
  view,
  onClose,
}: {
  url: string | null;
  alt: string;
  view: ZoomedView;
  onClose: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const panning = useRef<{ last: Point; moved: number } | null>(null);
  const panned = useRef(false);
  usePinchAndWheel(stage, view);
  useRoomSize(stage, view);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    panned.current = false;
    if (view.zoom <= view.fit || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    panning.current = { last: { x: event.clientX, y: event.clientY }, moved: 0 };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const at = panning.current;
    if (at === null) return;
    const by = { x: event.clientX - at.last.x, y: event.clientY - at.last.y };
    const moved = at.moved + Math.abs(by.x) + Math.abs(by.y);
    panning.current = { last: { x: event.clientX, y: event.clientY }, moved };
    if (moved > CLICK_SLOP) panned.current = true;
    view.panBy(by);
  };
  const endPan = () => {
    panning.current = null;
  };

  const { zoom, natural, pan } = view;
  const sized = natural.width > 0;
  return (
    <div
      ref={stage}
      className={zoom > view.fit ? 'lightbox__stage lightbox__stage--zoomed' : 'lightbox__stage'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onClick={(event) => {
        if (event.target === event.currentTarget && !panned.current) onClose();
      }}
      onDoubleClick={() => view.set(toggledZoom(zoom, view.fit))}
    >
      {url === null ? (
        <p className="lightbox__status">Loading…</p>
      ) : (
        <img
          className="lightbox__img"
          src={url}
          alt={alt}
          draggable={false}
          onLoad={(event) => {
            const img = event.currentTarget;
            view.measure({ natural: { width: img.naturalWidth, height: img.naturalHeight } });
          }}
          style={{
            ...(sized && { width: natural.width * zoom, height: natural.height * zoom }),
            transform: `translate(${pan.x}px, ${pan.y}px)`,
          }}
        />
      )}
    </div>
  );
}

/** Pinch and ⌘-scroll zoom. Bound by hand: React's wheel listener is passive, so it cannot stop the page's own. */
function usePinchAndWheel(stage: RefObject<HTMLDivElement | null>, view: ZoomedView) {
  const latest = useRef(view);
  useEffect(() => {
    latest.current = view;
  });
  useEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      // A trackpad pinch arrives as a wheel with the control key held.
      if (!(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      latest.current.set(zoomedByWheel(latest.current.zoom, event.deltaY));
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
      if (typeof scale === 'number') latest.current.set(clampZoom(pinchedFrom * scale));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('gesturestart', onGestureStart);
    element.addEventListener('gesturechange', onGestureChange);
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('gesturestart', onGestureStart);
      element.removeEventListener('gesturechange', onGestureChange);
    };
  }, [stage]);
}

/** Measures the stage, which fit is worked out against, now and whenever the window changes. */
function useRoomSize(stage: RefObject<HTMLDivElement | null>, view: ZoomedView) {
  const measure = useRef(view.measure);
  useEffect(() => {
    measure.current = view.measure;
  });
  useEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const read = () =>
      measure.current({ room: { width: element.clientWidth, height: element.clientHeight } });
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [stage]);
}

/** The viewer's controls: zoom out, the zoom, zoom in, fit, the images either side, and close. */
function ZoomBar({
  view,
  count,
  index,
  onStep,
}: {
  view: ZoomedView;
  count: number;
  index: number;
  onStep: (by: number) => void;
}) {
  return (
    <div className="lightbox__bar" role="toolbar" aria-label="Image viewer controls">
      {count > 1 && (
        <>
          <button
            type="button"
            className="lightbox__button"
            aria-label="Previous image"
            disabled={index === 0}
            onClick={() => onStep(-1)}
          >
            ‹
          </button>
          <span className="lightbox__count">
            {index + 1} of {count}
          </span>
          <button
            type="button"
            className="lightbox__button"
            aria-label="Next image"
            disabled={index === count - 1}
            onClick={() => onStep(1)}
          >
            ›
          </button>
        </>
      )}
      <button
        type="button"
        className="lightbox__button"
        aria-label="Zoom out"
        onClick={() => view.set(zoomedOut(view.zoom))}
      >
        −
      </button>
      <output className="lightbox__zoom" aria-label="Zoom">
        {zoomLabel(view.zoom)}
      </output>
      <button
        type="button"
        className="lightbox__button"
        aria-label="Zoom in"
        onClick={() => view.set(zoomedIn(view.zoom))}
      >
        +
      </button>
      <button
        type="button"
        className="lightbox__button lightbox__button--text"
        onClick={() => view.set(null)}
      >
        Fit
      </button>
      <Dialog.Close className="lightbox__button" aria-label="Close">
        ×
      </Dialog.Close>
    </div>
  );
}
