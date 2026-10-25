import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import {
  usePinchAndWheel,
  useRoomSize,
  useZoomedView,
  type ZoomedView,
} from './image-lightbox-view.ts';
import { toggledZoom, zoomedIn, zoomedOut, zoomLabel, type Point } from './image-zoom.ts';

/** An image of the note, as the viewer is handed it. */
export interface LightboxImage {
  readonly src: string;
  readonly alt: string;
}

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
  /** Puts the focus back where the viewer was opened from; false leaves it to the dialog. */
  onReturnFocus: () => boolean;
}) {
  const [index, setIndex] = useState(start);
  const image = images[index];
  const src = image?.src ?? '';
  const view = useZoomedView(src);
  const loaded = useLoadedUrl(src, loadImage);

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
          finalFocus={() => !onReturnFocus()}
        >
          <Dialog.Title className="visually-hidden">
            {image?.alt !== undefined && image.alt !== '' ? image.alt : 'Image'}
          </Dialog.Title>
          <Stage
            key={index}
            src={src}
            loaded={loaded}
            alt={image?.alt ?? ''}
            view={view}
            onClose={onClose}
          />
          <ZoomBar view={view} count={images.length} index={index} onStep={step} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** An image's url as it loads: none yet, or none to be had. */
type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly url: string };

function useLoadedUrl(src: string, loadImage: (src: string) => Promise<string | null>): Loaded {
  const [loaded, setLoaded] = useState<{ src: string; url: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadImage(src)
      .then((url) => {
        if (!cancelled) setLoaded({ src, url });
      })
      .catch(() => {
        // Shown as "couldn't be shown", which is all a failure here can say.
        if (!cancelled) setLoaded({ src, url: null });
      });
    return () => {
      cancelled = true;
    };
  }, [src, loadImage]);
  if (loaded === null || loaded.src !== src) return { kind: 'loading' };
  return loaded.url === null ? { kind: 'failed' } : { kind: 'ready', url: loaded.url };
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

/** Drag to pan a zoomed image; `panned` says whether the last press moved it, so it is no click. */
function usePanning(view: ZoomedView) {
  const panning = useRef<{ last: Point; moved: number } | null>(null);
  const panned = useRef(false);
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
  const end = () => {
    panning.current = null;
  };
  const handlers = { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end };
  return { handlers, panned };
}

/** The window the image is shown in: a click on it beside the image closes the viewer. */
function Stage({
  src,
  loaded,
  alt,
  view,
  onClose,
}: {
  src: string;
  loaded: Loaded;
  alt: string;
  view: ZoomedView;
  onClose: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [broken, setBroken] = useState(false);
  const { handlers, panned } = usePanning(view);
  usePinchAndWheel(stage, view);
  useRoomSize(stage, view);
  const { zoom, natural, pan } = view;

  return (
    <div
      ref={stage}
      className={zoom > view.fit ? 'lightbox__stage lightbox__stage--zoomed' : 'lightbox__stage'}
      {...handlers}
      onClick={(event) => {
        if (event.target === event.currentTarget && !panned.current) onClose();
      }}
      onDoubleClick={() => view.set(toggledZoom(zoom, view.fit))}
    >
      {loaded.kind === 'failed' || broken ? (
        <p className="lightbox__status">This picture couldn’t be shown</p>
      ) : loaded.kind === 'loading' ? (
        <p className="lightbox__status">Loading…</p>
      ) : (
        <img
          className="lightbox__img"
          src={loaded.url}
          alt={alt}
          draggable={false}
          // A picture the webview has already drawn may not load again: measured as it mounts.
          ref={(img) => {
            if (img !== null && img.complete && img.naturalWidth > 0) measure(img);
          }}
          onLoad={(event) => measure(event.currentTarget)}
          onError={() => setBroken(true)}
          style={{
            ...(natural.width > 0 && {
              width: natural.width * zoom,
              height: natural.height * zoom,
            }),
            transform: `translate(${pan.x}px, ${pan.y}px)`,
          }}
        />
      )}
    </div>
  );

  function measure(img: HTMLImageElement) {
    view.measureImage(src, { width: img.naturalWidth, height: img.naturalHeight });
  }
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
