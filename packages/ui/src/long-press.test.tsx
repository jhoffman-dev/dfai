// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LONG_PRESS } from '@dfai/domain';
import { useLongPress } from './long-press.ts';

afterEach(cleanup);

/**
 * A clock the test turns by hand, and the timers that read it: `advance`
 * moves both, so a hold is as long as the test says and not a moment longer.
 */
function fixedClock() {
  vi.useFakeTimers();
  let ms = 10_000;
  return {
    now: () => ms,
    advance: (by: number) => {
      ms += by;
      act(() => vi.advanceTimersByTime(by));
    },
  };
}

function Row({
  onLongPress,
  onClick,
  now,
}: {
  onLongPress: (at: { x: number; y: number }) => void;
  onClick: () => void;
  now: () => number;
}) {
  const press = useLongPress(onLongPress, { now });
  return (
    <button type="button" onClick={onClick} {...press}>
      Task
    </button>
  );
}

function show(now: () => number) {
  const onLongPress = vi.fn();
  const onClick = vi.fn();
  render(<Row onLongPress={onLongPress} onClick={onClick} now={now} />);
  return { row: screen.getByRole('button', { name: 'Task' }), onLongPress, onClick };
}

const finger = (x: number, y: number) => ({
  pointerType: 'touch',
  isPrimary: true,
  clientX: x,
  clientY: y,
});

describe('useLongPress', () => {
  afterEach(() => vi.useRealTimers());

  it('calls back where the finger rests once the hold has passed, and swallows the click after', () => {
    const clock = fixedClock();
    const { row, onLongPress, onClick } = show(clock.now);

    fireEvent.pointerDown(row, finger(40, 300));
    clock.advance(LONG_PRESS.holdMs - 1);
    expect(onLongPress).not.toHaveBeenCalled();
    clock.advance(1);
    expect(onLongPress).toHaveBeenCalledExactlyOnceWith({ x: 40, y: 300 });

    fireEvent.pointerUp(row, finger(40, 300));
    fireEvent.click(row, { detail: 1 });
    expect(onClick).not.toHaveBeenCalled();
    // The next tap is a tap again.
    fireEvent.click(row, { detail: 1 });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is a tap when the finger lifts before the hold, and the click goes through', () => {
    const clock = fixedClock();
    const { row, onLongPress, onClick } = show(clock.now);

    fireEvent.pointerDown(row, finger(40, 300));
    clock.advance(LONG_PRESS.holdMs - 50);
    fireEvent.pointerUp(row, finger(40, 300));
    fireEvent.click(row, { detail: 1 });
    clock.advance(LONG_PRESS.holdMs);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('gives a finger that drifts off into a scroll back to the page', () => {
    const clock = fixedClock();
    const { row, onLongPress } = show(clock.now);

    fireEvent.pointerDown(row, finger(40, 300));
    clock.advance(50);
    fireEvent.pointerMove(row, finger(40, 300 + LONG_PRESS.slopPx + 1));
    clock.advance(LONG_PRESS.holdMs);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('allows a resting finger its wobble, and reports where it came to rest', () => {
    const clock = fixedClock();
    const { row, onLongPress } = show(clock.now);

    fireEvent.pointerDown(row, finger(40, 300));
    clock.advance(50);
    fireEvent.pointerMove(row, finger(43, 302));
    clock.advance(LONG_PRESS.holdMs);
    expect(onLongPress).toHaveBeenCalledExactlyOnceWith({ x: 43, y: 302 });
  });

  it('leaves a mouse alone: its presses are clicks and right-clicks as before', () => {
    const clock = fixedClock();
    const { row, onLongPress, onClick } = show(clock.now);

    fireEvent.pointerDown(row, { ...finger(40, 300), pointerType: 'mouse' });
    clock.advance(LONG_PRESS.holdMs * 2);
    fireEvent.pointerUp(row, { ...finger(40, 300), pointerType: 'mouse' });
    fireEvent.click(row, { detail: 1 });
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledOnce();
  });

  // A hold does not always end in a click: the system's own long press can
  // cancel the touch, or a contextmenu comes in the click's place. What the
  // hold left behind must not swallow a later, unrelated click.
  it('swallows nothing of the mouse after a hold that raised no click', () => {
    const clock = fixedClock();
    const { row, onLongPress, onClick } = show(clock.now);

    fireEvent.pointerDown(row, finger(40, 300));
    clock.advance(LONG_PRESS.holdMs);
    expect(onLongPress).toHaveBeenCalledOnce();
    fireEvent.pointerCancel(row);

    const mouse = { ...finger(40, 300), pointerType: 'mouse' };
    fireEvent.pointerDown(row, mouse);
    fireEvent.pointerUp(row, mouse);
    fireEvent.click(row, { detail: 1 });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('swallows no keyboard click after a hold that raised no click', () => {
    const clock = fixedClock();
    const { row, onLongPress, onClick } = show(clock.now);

    fireEvent.pointerDown(row, finger(40, 300));
    clock.advance(LONG_PRESS.holdMs);
    expect(onLongPress).toHaveBeenCalledOnce();
    fireEvent.pointerUp(row, finger(40, 300));

    // Enter or Space on the focused row: a click with no press counted.
    fireEvent.click(row, { detail: 0 });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('waits what is left when its timer runs before the clock says the hold has passed', () => {
    vi.useFakeTimers();
    // The clock lags the timers: the first look finds the hold still short.
    let ms = 0;
    const now = () => ms;
    const { row, onLongPress } = show(now);

    fireEvent.pointerDown(row, finger(40, 300));
    ms = LONG_PRESS.holdMs - 100;
    act(() => vi.advanceTimersByTime(LONG_PRESS.holdMs));
    expect(onLongPress).not.toHaveBeenCalled();
    ms = LONG_PRESS.holdMs;
    act(() => vi.advanceTimersByTime(100));
    expect(onLongPress).toHaveBeenCalledOnce();
  });
});
