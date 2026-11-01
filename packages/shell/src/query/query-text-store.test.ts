import { describe, expect, it, vi } from 'vitest';
import { createQueryTextStore, queryTextOf, setQueryText } from './query-text-store.ts';

describe('the query text store', () => {
  it('holds each tab’s query apart, and nothing for a tab once it goes', () => {
    const store = createQueryTextStore();
    expect(queryTextOf(store, 't1')).toBeNull();
    setQueryText(store, 't1', 'FROM task');
    setQueryText(store, 't2', 'FROM person');
    expect(queryTextOf(store, 't1')).toBe('FROM task');
    expect(queryTextOf(store, 't2')).toBe('FROM person');
    setQueryText(store, 't1', null);
    expect(queryTextOf(store, 't1')).toBeNull();
    expect(queryTextOf(store, 't2')).toBe('FROM person');
  });

  it('tells a subscriber of a change, and not of the same text said again', () => {
    const store = createQueryTextStore();
    const told = vi.fn();
    store.subscribe(told);
    setQueryText(store, 't1', 'FROM task');
    setQueryText(store, 't1', 'FROM task');
    expect(told).toHaveBeenCalledTimes(1);
    setQueryText(store, 't1', 'FROM task WHERE status = "next"');
    expect(told).toHaveBeenCalledTimes(2);
    setQueryText(store, 't9', null);
    expect(told).toHaveBeenCalledTimes(2);
  });
});
