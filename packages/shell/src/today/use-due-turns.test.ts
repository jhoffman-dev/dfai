// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDueTurns } from './use-due-turns.ts';

/** #928: an open Today page reads again once a timed due's time has passed, on a fixed clock. */
let wall = '2026-12-04T15:29:00';
const clock = { localNow: () => wall };

beforeEach(() => {
  vi.useFakeTimers();
  wall = '2026-12-04T15:29:00';
});
afterEach(() => vi.useRealTimers());

const hook = (turn: string | null, open = true) =>
  renderHook(
    (props: { turn: string | null; open: boolean }) => useDueTurns(clock, props.open, props.turn),
    {
      initialProps: { turn, open },
    },
  );

describe('useDueTurns', () => {
  it('counts a turn the minute after its time, once, asked each minute', () => {
    const { result } = hook('15:30');
    expect(result.current).toBe(0);
    wall = '2026-12-04T15:30:59';
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(0);
    wall = '2026-12-04T15:31:00';
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(result.current).toBe(1);
  });

  it('counts the next turn the read hands it', () => {
    const { result, rerender } = hook('15:30');
    wall = '2026-12-04T15:31:00';
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(1);
    rerender({ turn: '17:00', open: true });
    expect(result.current).toBe(1);
    wall = '2026-12-04T17:01:00';
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(2);
  });

  it('asks again when the window is looked at again', () => {
    const { result } = hook('15:30');
    wall = '2026-12-04T15:45:00';
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(result.current).toBe(1);
  });

  it('counts nothing with no turn ahead, or on a closed page', () => {
    const none = hook(null);
    const closed = hook('15:30', false);
    wall = '2026-12-04T23:00:00';
    act(() => vi.advanceTimersByTime(60_000));
    expect(none.result.current).toBe(0);
    expect(closed.result.current).toBe(0);
  });
});
