// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Active, DragMoveEvent, DragStartEvent } from '@dnd-kit/core';
import type { CalendarEvent, TrayTask } from '@dfai/domain';
import type { CalendarGestures } from '../calendar-gestures.ts';
import { useClockDrag } from './clock-drag.ts';
import { trayDragId, useTrayDrag } from './tray-drag.ts';

/**
 * #450: dnd-kit reports a move from an effect after the render it caused, so
 * one still pending as Escape or a drop lands is reported after the drag is
 * over — to the handlers first, then to the announcements. Heard then, it
 * would say where the task "would go" (or that it is "not over the calendar")
 * in place of "Cancelled".
 */

const call: TrayTask = { path: 'Call Mara.md', title: 'Call Mara', schedule: null, chosen: false };

function move(active: Active, delta = { x: 0, y: 48 }): DragMoveEvent {
  return { active, delta, over: null, collisions: null } as unknown as DragMoveEvent;
}

describe('a task from the tray, moved once the drag is over', () => {
  const setup = () => {
    const { result } = renderHook(() =>
      useTrayDrag({
        tasks: [call],
        onPlace: vi.fn(),
        within: () => document.body,
        // jsdom lays nothing out, so nothing is under the pointer.
        elementsAt: () => [],
      }),
    );
    const active = { id: trayDragId(call) } as Active;
    result.current.onDragStart({
      active,
      activatorEvent: new MouseEvent('pointerdown', { clientX: 10, clientY: 10 }),
    } as DragStartEvent);
    return { drag: result.current, active };
  };

  it('says nothing after a cancel, so "Cancelled" is what is heard', () => {
    const { drag, active } = setup();
    expect(drag.announcements.onDragMove?.(move(active))).toBe(
      'Call Mara is not over the calendar.',
    );
    drag.onDragCancel();
    drag.onDragMove();
    expect(drag.announcements.onDragMove?.(move(active))).toBeUndefined();
  });

  it('says nothing after a drop', () => {
    const { drag, active } = setup();
    drag.onDragEnd({ active });
    drag.onDragMove();
    expect(drag.announcements.onDragMove?.(move(active))).toBeUndefined();
  });
});

describe('a note on the clock, moved once the drag is over', () => {
  const note: CalendarEvent = {
    path: 'Standup.md',
    title: 'Standup',
    values: {},
    start: { date: '2026-10-12', minutes: 9 * 60 },
    end: null,
  };
  const gestures = {
    onHold: vi.fn(),
    move: vi.fn(),
    resize: vi.fn(),
    landing: () => '2026-10-12T10:00',
  } as unknown as CalendarGestures;

  const setup = () => {
    const { result } = renderHook(() =>
      useClockDrag({ events: [note], gestures, dayWidth: () => 100 }),
    );
    const active = { id: note.path } as Active;
    result.current.onDragStart();
    return { drag: result.current, active };
  };

  it('says nothing after a cancel, so "Cancelled" is what is heard', () => {
    const { drag, active } = setup();
    drag.onDragMove(move(active));
    expect(drag.announcements.onDragMove?.(move(active))).toMatch(/Standup/);
    drag.onDragCancel();
    drag.onDragMove(move(active));
    expect(drag.announcements.onDragMove?.(move(active))).toBeUndefined();
  });

  it('says nothing after a drop', () => {
    const { drag, active } = setup();
    drag.onDragEnd({ active, delta: { x: 0, y: 48 } } as never);
    drag.onDragMove(move(active));
    expect(drag.announcements.onDragMove?.(move(active))).toBeUndefined();
  });
});
