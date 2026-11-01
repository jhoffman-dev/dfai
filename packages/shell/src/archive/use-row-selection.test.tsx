// @vitest-environment jsdom
/** Choosing rows, and a run of them with Shift-click (#168). */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { rowsBetween, useRowSelection } from './use-row-selection.ts';

const ORDER = ['a', 'b', 'c', 'd', 'e'];

describe('rowsBetween', () => {
  it('is every row from one to the other, both included, either way round', () => {
    expect(rowsBetween(ORDER, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rowsBetween(ORDER, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rowsBetween(ORDER, 'c', 'c')).toEqual(['c']);
  });

  it('is null with nowhere to start from, or an end not on the list', () => {
    expect(rowsBetween(ORDER, null, 'b')).toBeNull();
    expect(rowsBetween(ORDER, 'gone', 'b')).toBeNull();
    expect(rowsBetween(ORDER, 'b', 'gone')).toBeNull();
  });
});

describe('useRowSelection — Shift-click', () => {
  it('chooses the run from the row last toggled to the one Shift-clicked', () => {
    const { result } = renderHook(() => useRowSelection(''));
    act(() => result.current.selection.onToggle('b'));
    act(() => result.current.selection.onToggle('d', { order: ORDER }));
    expect([...result.current.selection.selected].sort()).toEqual(['b', 'c', 'd']);
  });

  it('toggles the row alone when nothing was toggled before', () => {
    const { result } = renderHook(() => useRowSelection(''));
    act(() => result.current.selection.onToggle('c', { order: ORDER }));
    expect([...result.current.selection.selected]).toEqual(['c']);
  });

  it('adds a run to what was chosen, leaving the rest chosen', () => {
    const { result } = renderHook(() => useRowSelection(''));
    act(() => result.current.selection.onToggle('a'));
    act(() => result.current.selection.onToggle('d'));
    act(() => result.current.selection.onToggle('e', { order: ORDER }));
    expect([...result.current.selection.selected].sort()).toEqual(['a', 'd', 'e']);
  });
});

describe('useRowSelection — where a run starts once a batch settles', () => {
  it('lets go of the start once a batch answered its row', () => {
    const { result } = renderHook(() => useRowSelection(''));
    act(() => result.current.selection.onToggle('b'));
    act(() => result.current.afterBatch({ answered: ['b'], failed: [] }));
    act(() => result.current.selection.onToggle('d', { order: ORDER }));
    expect([...result.current.selection.selected]).toEqual(['d']);
  });

  it('keeps the start when its row failed and is chosen again', () => {
    const { result } = renderHook(() => useRowSelection(''));
    act(() => result.current.selection.onToggle('b'));
    act(() => result.current.afterBatch({ answered: ['b'], failed: ['b'] }));
    act(() => result.current.selection.onToggle('d', { order: ORDER }));
    expect([...result.current.selection.selected].sort()).toEqual(['b', 'c', 'd']);
  });

  it('keeps the start when the batch answers other rows', () => {
    const { result } = renderHook(() => useRowSelection(''));
    act(() => result.current.selection.onToggle('a'));
    act(() => result.current.selection.onToggle('b'));
    act(() => result.current.afterBatch({ answered: ['a'], failed: [] }));
    act(() => result.current.selection.onToggle('d', { order: ORDER }));
    expect([...result.current.selection.selected].sort()).toEqual(['b', 'c', 'd']);
  });
});
