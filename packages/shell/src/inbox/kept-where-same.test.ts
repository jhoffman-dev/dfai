import { describe, expect, it } from 'vitest';
import { keptWhereSame } from './kept-where-same.ts';

const row = (path: string, title: string) => ({ path, title });
const byPath = (each: { path: string }) => each.path;

describe('keptWhereSame (#217)', () => {
  it('keeps the earlier object for a row that holds the same', () => {
    const before = [row('a', 'Call Mara'), row('b', 'Pay Tobias')];
    const next = [row('a', 'Call Mara'), row('b', 'Pay Tobias, today')];
    const kept = keptWhereSame(before, next, byPath);
    expect(kept[0]).toBe(before[0]);
    expect(kept[1]).toBe(next[1]);
  });

  it('hands back the earlier list itself when nothing changed', () => {
    const before = [row('a', 'Call Mara')];
    expect(keptWhereSame(before, [row('a', 'Call Mara')], byPath)).toBe(before);
  });

  it('is a new list once a row has left it', () => {
    const before = [row('a', 'Call Mara'), row('b', 'Pay Tobias')];
    const kept = keptWhereSame(before, [row('b', 'Pay Tobias')], byPath);
    expect(kept).not.toBe(before);
    expect(kept).toEqual([row('b', 'Pay Tobias')]);
    expect(kept[0]).toBe(before[1]);
  });

  it('takes the new list whole when there was none before', () => {
    const next = [row('a', 'Call Mara')];
    expect(keptWhereSame(null, next, byPath)).toBe(next);
  });
});
