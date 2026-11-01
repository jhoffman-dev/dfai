import { describe, expect, it } from 'vitest';
import { holdRemaining, judgePress, LONG_PRESS, type PressPoint } from './long-press.ts';

// A fixed clock: every time here is a number the test chose.
const START: PressPoint = { x: 100, y: 200, at: 1_000 };
const after = (ms: number, dx = 0, dy = 0): PressPoint => ({
  x: START.x + dx,
  y: START.y + dy,
  at: START.at + ms,
});

describe('judgePress', () => {
  it('is pending until the hold has passed, and long from then on', () => {
    expect(judgePress(START, after(0))).toBe('pending');
    expect(judgePress(START, after(LONG_PRESS.holdMs - 1))).toBe('pending');
    expect(judgePress(START, after(LONG_PRESS.holdMs))).toBe('long');
    expect(judgePress(START, after(LONG_PRESS.holdMs + 500))).toBe('long');
  });

  it('allows a resting finger its wobble, in any direction', () => {
    expect(judgePress(START, after(10, LONG_PRESS.slopPx, 0))).toBe('pending');
    expect(judgePress(START, after(10, 0, -LONG_PRESS.slopPx))).toBe('pending');
    expect(judgePress(START, after(LONG_PRESS.holdMs, -5, 5))).toBe('long');
  });

  it('is a scroll once the finger drifts past the slop, however long it was held', () => {
    expect(judgePress(START, after(10, LONG_PRESS.slopPx + 1, 0))).toBe('scrolled');
    expect(judgePress(START, after(10, 6, 6))).toBe('scrolled');
    expect(judgePress(START, after(LONG_PRESS.holdMs + 1, 0, 20))).toBe('scrolled');
  });

  it('judges by the policy it is handed', () => {
    const slow = { holdMs: 1_000, slopPx: 2 };
    expect(judgePress(START, after(500), slow)).toBe('pending');
    expect(judgePress(START, after(1_000), slow)).toBe('long');
    expect(judgePress(START, after(1_000, 3, 0), slow)).toBe('scrolled');
  });

  it('holds for less than the system long press, with room for a finger to wobble', () => {
    expect(LONG_PRESS.holdMs).toBeLessThan(500);
    expect(LONG_PRESS.holdMs).toBeGreaterThanOrEqual(200);
    expect(LONG_PRESS.slopPx).toBeGreaterThan(0);
  });
});

describe('holdRemaining', () => {
  it('counts down to the hold and never below nothing', () => {
    expect(holdRemaining(START, START.at)).toBe(LONG_PRESS.holdMs);
    expect(holdRemaining(START, START.at + 100)).toBe(LONG_PRESS.holdMs - 100);
    expect(holdRemaining(START, START.at + LONG_PRESS.holdMs)).toBe(0);
    expect(holdRemaining(START, START.at + LONG_PRESS.holdMs + 50)).toBe(0);
  });

  it('counts by the policy it is handed', () => {
    expect(holdRemaining(START, START.at + 100, { holdMs: 600, slopPx: 8 })).toBe(500);
  });
});
