import { describe, expect, it } from 'vitest';
import { recentCache } from './recent-cache.ts';

/* The few chapters parsed last, and no more (#505). */

describe('a cache of the values used last', () => {
  it('holds at most its size, letting go of the one used longest ago', () => {
    const cache = recentCache<number, string>(3);
    for (const at of [1, 2, 3]) cache.set(at, `chapter ${at}`);
    expect(cache.get(1)).toBe('chapter 1');
    cache.set(4, 'chapter 4');
    expect(cache.size).toBe(3);
    expect(cache.get(2)).toBeUndefined();
    expect([1, 3, 4].map((at) => cache.get(at))).toEqual(['chapter 1', 'chapter 3', 'chapter 4']);
  });

  it('counts setting a value again as using it', () => {
    const cache = recentCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);
    cache.set('c', 3);
    expect(cache.get('a')).toBe(10);
    expect(cache.get('b')).toBeUndefined();
  });

  it('lets one go, or all, when asked', () => {
    const cache = recentCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('holds at least one value', () => {
    expect(() => recentCache(0)).toThrow(/at least one/);
    expect(() => recentCache(1.5)).toThrow(/at least one/);
  });
});
