import { useCallback, type KeyboardEvent, type ReactNode } from 'react';
import {
  DndContext,
  closestCenter,
  useDraggable,
  useDroppable,
  pointerWithin,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import { usePressSensors } from './drag/dnd.ts';
import { Icon } from './icon.tsx';

/**
 * The row under the pointer; in a gap between rows, or past either end of the
 * list, the one nearest the pointer. dnd-kit's own "nearest" measures from the
 * held row's centre, and a tall row — a sidebar section with a long list — has
 * its centre far from the grip being dragged, so it would land somewhere else.
 */
const rowUnderPointer: CollisionDetection = (args) => {
  const under = pointerWithin(args);
  if (under.length > 0) return under;
  const pointer = args.pointerCoordinates;
  if (pointer === null) return closestCenter(args);

  const gaps = args.droppableContainers.flatMap((container) => {
    const rect = args.droppableRects.get(container.id);
    if (rect === undefined) return [];
    const across = Math.max(rect.left - pointer.x, 0, pointer.x - rect.right);
    const down = Math.max(rect.top - pointer.y, 0, pointer.y - rect.bottom);
    return [
      {
        id: container.id,
        data: { droppableContainer: container, value: Math.hypot(across, down) },
      },
    ];
  });
  return gaps.sort((a, b) => a.data.value - b.data.value).slice(0, 1);
};

/**
 * A list whose rows can be put in another order: dragged by their handle, or
 * moved one place at a time with Alt+Up and Alt+Down while the handle has
 * focus. What the new order means is the caller's; this only reports a move.
 */
export function SortableList<Item>({
  items,
  idOf,
  nameOf,
  onMove,
  canMove,
  className,
  children,
}: {
  items: readonly Item[];
  idOf: (item: Item) => string;
  /** What the handle's accessible name calls the row: "Move Status". */
  nameOf: (item: Item) => string;
  onMove: (args: { id: string; to: number }) => void;
  /**
   * Whether a row may go to a place, when not every place in the list will do;
   * a move it refuses is not reported, and Alt+arrow stops there.
   */
  canMove?: (args: { id: string; to: number }) => boolean;
  className?: string;
  children: (item: Item, handle: ReactNode) => ReactNode;
}) {
  const sensors = useSensors(...usePressSensors());
  const ids = items.map(idOf);
  const allowed = (move: { id: string; to: number }) =>
    move.to >= 0 && move.to < items.length && (canMove?.(move) ?? true);

  const drop = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    const move = { id: String(active.id), to: ids.indexOf(String(over.id)) };
    if (allowed(move)) onMove(move);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={rowUnderPointer} onDragEnd={drop}>
      <ul className={className}>
        {items.map((item, at) => (
          <SortableRow
            key={idOf(item)}
            id={idOf(item)}
            name={nameOf(item)}
            onStep={(step) => onMove({ id: idOf(item), to: at + step })}
            canStep={(step) => allowed({ id: idOf(item), to: at + step })}
          >
            {(handle) => children(item, handle)}
          </SortableRow>
        ))}
      </ul>
    </DndContext>
  );
}

/**
 * Brings a handle back into its scroller's view once the move it asked for has
 * landed and slid (reorder-transition.ts). The row it moves may land a long
 * way off — below a virtualised section, say — while the scroller stays
 * anchored on what it was showing, and the focus would be out of sight.
 */
function keepInView(handle: HTMLElement): void {
  requestAnimationFrame(() => {
    const row = handle.closest<HTMLElement>('[data-reorder-id]') ?? handle;
    const sliding =
      typeof row.getAnimations === 'function'
        ? row.getAnimations().map((animation) => animation.finished)
        : [];
    void Promise.allSettled(sliding).then(() => {
      // jsdom has no scrollIntoView; with nothing to scroll there is nothing to keep.
      if (handle.isConnected && typeof handle.scrollIntoView === 'function') {
        handle.scrollIntoView({ block: 'nearest' });
      }
    });
  });
}

function SortableRow({
  id,
  name,
  onStep,
  canStep,
  children,
}: {
  id: string;
  name: string;
  onStep: (step: number) => void;
  canStep: (step: number) => boolean;
  children: (handle: ReactNode) => ReactNode;
}) {
  const {
    setNodeRef: setDragRef,
    setActivatorNodeRef,
    listeners,
    transform,
    isDragging,
  } = useDraggable({ id });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id });
  // The row is both what is dragged and what another row is dropped on.
  const setRowRef = useCallback(
    (node: HTMLLIElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const step = event.key === 'ArrowUp' ? -1 : 1;
    if (!canStep(step)) return;
    onStep(step);
    keepInView(event.currentTarget);
  };

  // dnd-kit's `attributes` are left off: they describe its keyboard drag,
  // which is not wired here, and would promise what the handle does not do.
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      className="sortable__handle"
      aria-label={`Move ${name}`}
      title="Drag, or Alt+↑ / Alt+↓, to move"
      {...listeners}
      onKeyDown={onKeyDown}
    >
      <Icon name="grip" size={14} />
    </button>
  );

  return (
    <li
      ref={setRowRef}
      className={[
        'sortable__row',
        isDragging ? 'sortable__row--dragging' : '',
        isOver && !isDragging ? 'sortable__row--over' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        transform === null
          ? undefined
          : { transform: `translate3d(0, ${transform.y}px, 0)`, zIndex: 2 }
      }
    >
      {children(handle)}
    </li>
  );
}
