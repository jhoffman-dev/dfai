/**
 * The dnd-kit settings every drag surface shares (ADR-0015).
 *
 * Only glue lives here: which sensors, which keys, and how a keyboard press is
 * turned into a position. What a press *means* is decided in `snapping.ts`.
 */
import { useMemo, type PointerEvent as ReactPointerEvent } from 'react';
import {
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type ClientRect,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  type PointerSensorOptions,
} from '@dnd-kit/core';
import { LONG_PRESS } from '@dfai/domain';
import {
  boxContaining,
  centredOn,
  centreOf,
  directionOf,
  rowStep,
  type Direction,
} from './snapping.ts';

/**
 * How far a pointer travels before a press becomes a drag. Under it, the press
 * is a click and opens the note, exactly as it did before drag moved to
 * dnd-kit.
 */
const DRAG_DISTANCE = 4;

/**
 * Space only picks up. Enter on a focused card still opens the note, the way
 * Enter on any button does; taking it for drag would break that for everyone
 * who is not dragging. Tab cancels rather than drops: leaving the item is not a
 * decision to put it down there.
 */
const KEYBOARD_CODES = {
  start: ['Space'],
  cancel: ['Escape', 'Tab'],
  end: ['Space', 'Enter'],
};

const POINTER_OPTIONS = { activationConstraint: { distance: DRAG_DISTANCE } };

/**
 * A finger is held still for the long-press rule's hold before anything
 * moves (`LONG_PRESS`, the domain), and a finger that drifts further sooner is
 * scrolling: the press is given back to the page (#659). The touch sensor is
 * dnd-kit's own, since only it stops the page scrolling under a drag once the
 * hold has passed.
 */
const TOUCH_OPTIONS = {
  activationConstraint: { delay: LONG_PRESS.holdMs, tolerance: LONG_PRESS.slopPx },
};

/**
 * The pointer sensor, for the mouse and the pen alone. A pointer event is
 * raised for every touch too, and taking it would start the drag at the first
 * few pixels, before the hold — and take the scroll with it. So a touch is the
 * touch sensor's, and the mouse behaves exactly as it did.
 */
export class FinePointerSensor extends PointerSensor {
  static override activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: (event: ReactPointerEvent, options: PointerSensorOptions): boolean =>
        event.nativeEvent.pointerType !== 'touch' &&
        (PointerSensor.activators[0]?.handler(event, options) ?? false),
    },
  ];
}

/** The sensors a press drags by, on every drag surface: a mouse or pen by travel, a finger by a hold. */
export function usePressSensors() {
  // The same options from one render to the next: dnd-kit makes its sensors,
  // and the context every draggable reads, anew for new ones (#238).
  return [useSensor(FinePointerSensor, POINTER_OPTIONS), useSensor(TouchSensor, TOUCH_OPTIONS)];
}

export function useDragSensors(coordinateGetter: KeyboardCoordinateGetter) {
  // Steady for the same reason as the press sensors' options: new options drew
  // every row of the sidebar again on each of its renders (#238).
  const keyboard = useMemo(
    () => ({
      coordinateGetter,
      keyboardCodes: KEYBOARD_CODES,
      // When a step leads off the visible part of a pane, the sensor scrolls the
      // pane rather than moving the item. A smooth scroll is still under way
      // when the next arrow arrives, and that step is then worked out from
      // where things were — so a quick Down, Left lost the Down. An instant
      // scroll is finished before the next key.
      scrollBehavior: 'auto' as const,
    }),
    [coordinateGetter],
  );
  return useSensors(...usePressSensors(), useSensor(KeyboardSensor, keyboard));
}

/**
 * The drop target is whatever is under the pointer, as it was with native drag.
 * A keyboard drag has no pointer, so the centre of the held item stands in for
 * one — and the keyboard moves that centre onto the target's.
 */
export const dropTargetUnder: CollisionDetection = (args) => {
  if (args.pointerCoordinates !== null) return pointerWithin(args);
  return pointerWithin({ ...args, pointerCoordinates: centreOf(args.collisionRect) });
};

/**
 * `dropTargetUnder`, for targets in a scroller: a pointer outside `shown` —
 * the part of the scroller that shows its targets, below any heading stuck
 * over its top — is over no target, though one may be laid out beneath it. A
 * keyboard drag has no pointer to be covered, and keeps the plain rule. With
 * nothing shown (`null`), it is the plain rule too.
 */
export function dropTargetWithin(shown: () => ClientRect | null): CollisionDetection {
  return (args) => {
    const point = args.pointerCoordinates;
    const area = point === null ? null : shown();
    const outside =
      point !== null &&
      area !== null &&
      (point.x < area.left || point.x > area.right || point.y < area.top || point.y > area.bottom);
    return outside ? [] : dropTargetUnder(args);
  };
}

/**
 * A keyboard step up or down a list to the next drop target, for the tree:
 * what is held starts between targets, so the step is found by position
 * (`rowStep`) rather than from the target it is over.
 */
export const snapToNextRow: KeyboardCoordinateGetter = (event, { context }) => {
  const direction = directionOf(event.code);
  if (direction === null) return undefined;
  // An arrow key while holding something must never scroll the tree instead.
  event.preventDefault();
  const { collisionRect, droppableRects } = context;
  if (collisionRect === null) return undefined;
  const target = rowStep(droppableRects, centreOf(collisionRect), direction);
  const box = target === null ? undefined : droppableRects.get(target);
  return box === undefined ? undefined : centredOn(box, collisionRect);
};

/**
 * A keyboard step that jumps from one drop target to the next rather than by
 * pixels. `next` names the target an arrow leads to from the current one.
 * `sideways` keeps the held item at its own height, for a board, where a column
 * is tall and the card should stay level with where it was.
 */
export function snapToDropTarget({
  next,
  sideways = false,
}: {
  next: (current: string, direction: Direction) => string;
  sideways?: boolean;
}): KeyboardCoordinateGetter {
  return (event, { context, currentCoordinates }) => {
    const direction = directionOf(event.code);
    if (direction === null) return undefined;
    // An arrow key while holding something must never scroll the page instead.
    event.preventDefault();

    const { collisionRect, droppableRects, over } = context;
    if (collisionRect === null) return undefined;
    const current = boxContaining(centreOf(collisionRect), droppableRects) ?? over?.id ?? null;
    if (current === null) return undefined;

    const target = next(String(current), direction);
    const box = droppableRects.get(target);
    if (target === String(current) || box === undefined) return undefined;

    const point = centredOn(box, collisionRect);
    return sideways ? { x: point.x, y: currentCoordinates.y } : point;
  };
}
