import { describe, expect, it } from 'vitest';
import { keepIfSame, sameReading } from './same-reading.ts';

describe('sameReading (#130)', () => {
  it('reads plain data the same by value, all the way down', () => {
    expect(
      sameReading(
        { moves: [{ from: 'a.md', to: 'b/a.md' }] },
        { moves: [{ from: 'a.md', to: 'b/a.md' }] },
      ),
    ).toBe(true);
    expect(sameReading(null, null)).toBe(true);
    expect(sameReading(Number.NaN, Number.NaN)).toBe(true);
  });

  it('tells apart a changed value, a missing or extra key, and a reordered list', () => {
    expect(sameReading({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameReading({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameReading({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(false);
    expect(sameReading([1, 2], [2, 1])).toBe(false);
    expect(sameReading([1], [1, 1])).toBe(false);
    expect(sameReading([], {})).toBe(false);
    expect(sameReading(null, {})).toBe(false);
  });

  it('compares Maps and Sets by what they hold, not as empty objects', () => {
    expect(sameReading(new Map([['k', [1]]]), new Map([['k', [1]]]))).toBe(true);
    expect(sameReading(new Map([['k', 1]]), new Map([['k', 2]]))).toBe(false);
    expect(sameReading(new Map([['k', 1]]), new Map([['j', 1]]))).toBe(false);
    expect(sameReading(new Set(['a']), new Set(['a']))).toBe(true);
    expect(sameReading(new Set(['a']), new Set(['b']))).toBe(false);
    expect(sameReading(new Map(), {})).toBe(false);
    expect(sameReading(new Set(), [])).toBe(false);
  });

  it('keeps the earlier value when the new one reads the same, so a setter changes nothing', () => {
    const was = { rows: [{ path: 'Meetings/a.md' }] };
    expect(keepIfSame(was, { rows: [{ path: 'Meetings/a.md' }] })).toBe(was);
    const now = { rows: [{ path: 'Meetings/b.md' }] };
    expect(keepIfSame(was, now)).toBe(now);
  });
});
