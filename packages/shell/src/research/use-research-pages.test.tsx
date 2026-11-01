// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  createVaultPath,
  highlightChoices,
  libraryChoices,
  NO_HIGHLIGHT_FILTER,
  NO_LIBRARY_FILTER,
  type HighlightEntry,
  type LibraryEntry,
} from '@dfai/domain';
import { useHighlightsPage, useLibraryPage } from './use-research-pages.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 22);

const source = (name: string, rest: Partial<LibraryEntry> = {}): LibraryEntry => ({
  path: createVaultPath(`Library/${name}.md`),
  title: name,
  author: null,
  kind: 'pdf',
  highlights: 0,
  modified: 0,
  tags: [],
  projects: [],
  cover: null,
  ...rest,
});

const highlight = (id: string, modified: number): HighlightEntry => ({
  path: createVaultPath('Library/A.md'),
  source: 'A',
  modified,
  index: 0,
  id,
  kind: 'pdf',
  quote: id,
  comment: '',
  mark: 'highlight',
  color: 'yellow',
  page: null,
  location: null,
  tags: [],
});

describe('useLibraryPage', () => {
  it('passes a read that is not ready through, and offers no choices for it', () => {
    const { result } = renderHook(() => useLibraryPage({ kind: 'loading' }));
    expect(result.current.state).toEqual({ kind: 'loading' });
    expect(result.current.choices).toEqual({ kinds: [], tags: [], projects: [] });
  });

  it('shows the sources newest first, then as the filter and order the page sets', () => {
    const entries = [source('B', { modified: 1 }), source('A', { modified: 2, kind: 'epub' })];
    const read = { kind: 'ready' as const, entries, choices: libraryChoices(entries) };
    const { result } = renderHook(() => useLibraryPage(read));
    const titles = () =>
      result.current.state.kind === 'ready'
        ? result.current.state.shown.map((each) => each.title)
        : [];
    expect(titles()).toEqual(['A', 'B']);
    act(() => result.current.onSort({ key: 'title', descending: true }));
    expect(titles()).toEqual(['B', 'A']);
    act(() => result.current.onFilter({ ...NO_LIBRARY_FILTER, kinds: ['epub'] }));
    expect(titles()).toEqual(['A']);
    expect(result.current.state).toMatchObject({ total: 2 });
    expect(result.current.choices.kinds.map((choice) => choice.value)).toEqual(['pdf', 'epub']);
  });
});

describe('useHighlightsPage', () => {
  it('counts "changed within" back from the clock, read as the filter is set', () => {
    let now = NOW;
    const entries = [highlight('new', NOW - DAY), highlight('old', NOW - 20 * DAY)];
    const read = { kind: 'ready' as const, entries, choices: highlightChoices(entries) };
    const { result } = renderHook(() => useHighlightsPage(read, () => now));
    const ids = () =>
      result.current.state.kind === 'ready'
        ? result.current.state.shown.map((each) => each.id)
        : [];
    expect(ids()).toEqual(['new', 'old']);
    act(() => result.current.onFilter({ ...NO_HIGHLIGHT_FILTER, changed: 'week' }));
    expect(ids()).toEqual(['new']);
    // A week on, the same filter set again counts from the new now.
    now = NOW + 7 * DAY;
    act(() => result.current.onFilter({ ...NO_HIGHLIGHT_FILTER, changed: 'week' }));
    expect(ids()).toEqual([]);
    expect(result.current.filter.changed).toBe('week');
  });

  it('passes a failed read through as the page shows it', () => {
    const failed = { kind: 'failed' as const, message: 'busy' };
    const { result } = renderHook(() => useHighlightsPage(failed, () => NOW));
    expect(result.current.state).toEqual(failed);
    expect(result.current.choices).toEqual({ sources: [], colors: [], tags: [] });
  });
});
