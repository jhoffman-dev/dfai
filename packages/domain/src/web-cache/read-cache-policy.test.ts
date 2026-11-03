import { describe, expect, it } from 'vitest';
import {
  cachedReadBytes,
  cachedReadKey,
  cachedReadOf,
  evictionsToFit,
  fitsInReadCache,
  isCachedNoteStale,
  type CachedReadFacts,
} from './read-cache-policy.ts';

const entry = (key: string, bytes: number, usedAt: number): CachedReadFacts => ({
  key,
  bytes,
  usedAt,
});

describe('the read cache keys', () => {
  it('round-trips the account, the kind and what was asked, a path with any character in it', () => {
    const key = cachedReadKey('mara-quill|github:a/b#main', 'note', 'Garden/Plan: beans.md');
    expect(cachedReadOf(key)).toEqual({
      scope: 'mara-quill|github:a/b#main',
      kind: 'note',
      asked: 'Garden/Plan: beans.md',
    });
  });

  it('never gives a note and a listing, or two accounts’ notes, the same key', () => {
    expect(cachedReadKey('a', 'note', 'Garden')).not.toBe(
      cachedReadKey('a', 'directory', 'Garden'),
    );
    expect(cachedReadKey('a', 'note', 'Garden')).not.toBe(cachedReadKey('b', 'note', 'Garden'));
  });
});

describe('evicting least recently used', () => {
  it('drops nothing while everything fits, even exactly at the cap', () => {
    expect(evictionsToFit([entry('a', 40, 1), entry('b', 60, 2)], 100)).toEqual([]);
  });

  it('drops the longest unused first, only as many as it takes', () => {
    const entries = [entry('new', 50, 30), entry('old', 50, 10), entry('mid', 50, 20)];
    expect(evictionsToFit(entries, 100)).toEqual(['old']);
    expect(evictionsToFit(entries, 50)).toEqual(['old', 'mid']);
  });

  it('breaks a tie of use by key, whatever order the store listed them in', () => {
    const one = evictionsToFit([entry('b', 10, 5), entry('a', 10, 5)], 10);
    const other = evictionsToFit([entry('a', 10, 5), entry('b', 10, 5)], 10);
    expect(one).toEqual(['a']);
    expect(other).toEqual(['a']);
  });

  it('drops everything when the cap is nothing', () => {
    expect(evictionsToFit([entry('a', 1, 1), entry('b', 1, 2)], 0)).toEqual(['a', 'b']);
  });

  it('keeps no single read larger than the whole cap', () => {
    expect(fitsInReadCache(101, 100)).toBe(false);
    expect(fitsInReadCache(100, 100)).toBe(true);
  });

  it('counts a value at two bytes a character of its JSON', () => {
    expect(cachedReadBytes({ text: 'ab' })).toBe(JSON.stringify({ text: 'ab' }).length * 2);
  });
});

describe('a kept note against the tree', () => {
  it('is stale once the tree names another version, or none', () => {
    expect(isCachedNoteStale(7, 7)).toBe(false);
    expect(isCachedNoteStale(7, 8)).toBe(true);
    expect(isCachedNoteStale(7, undefined)).toBe(true);
  });
});
