import { useRef, type PointerEvent } from 'react';
import { resizedImageWidth } from '@dfai/domain';

interface Drag {
  readonly fromX: number;
  readonly fromWidth: number;
  readonly column: number;
  /** 1 for the right handle, which widens as it moves right; -1 for the left. */
  readonly sign: 1 | -1;
  width: number | null;
}

/**
 * The handles either side of an image that resize it (#568). A drag draws
 * the new width as it goes (`onDrag`) and hands it over once, on release
 * (`onRelease`), so the note is written once and one undo puts it back. A
 * double-click on a handle goes back to the image's own size (`onReset`).
 */
export function ImageResizeHandles({
  onDrag,
  onRelease,
  onReset,
}: {
  onDrag: (width: number) => void;
  onRelease: (width: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<Drag | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLSpanElement>, sign: 1 | -1) => {
    if (event.button !== 0) return;
    const image = event.currentTarget.parentElement?.querySelector('img');
    if (!(image instanceof HTMLImageElement)) return;
    // Kept from ProseMirror, which would otherwise select or drag the image.
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      fromX: event.clientX,
      fromWidth: image.getBoundingClientRect().width,
      column: columnWidth(image),
      sign,
      width: null,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    const at = drag.current;
    if (at === null) return;
    const wanted = at.fromWidth + at.sign * (event.clientX - at.fromX);
    at.width = resizedImageWidth({ width: wanted, column: at.column });
    onDrag(at.width);
  };
  const onPointerUp = () => {
    const at = drag.current;
    drag.current = null;
    if (at !== null && at.width !== null) onRelease(at.width);
  };

  const handle = (side: 'left' | 'right', sign: 1 | -1) => (
    <span
      className={`image__handle image__handle--${side}`}
      contentEditable={false}
      draggable={false}
      aria-hidden="true"
      title="Drag to resize; double-click for its own size"
      onPointerDown={(event) => onPointerDown(event, sign)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDragStart={(event) => event.preventDefault()}
      onDoubleClick={(event) => {
        event.preventDefault();
        onReset();
      }}
    />
  );
  return (
    <>
      {handle('left', -1)}
      {handle('right', 1)}
    </>
  );
}

/** How wide the line the image is in can hold it. */
function columnWidth(image: HTMLElement): number {
  const line = image.closest('p, li, td, th, blockquote') ?? image.closest('.ProseMirror');
  return line instanceof HTMLElement && line.clientWidth > 0
    ? line.clientWidth
    : Number.POSITIVE_INFINITY;
}
