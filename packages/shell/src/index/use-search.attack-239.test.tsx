// @vitest-environment jsdom
/**
 * Attacks on ⌘K holding its search while the index is `building` (#239): the
 * person keeps typing through a first sync or a rebuild, and the key may flip
 * back and forth. Each query has its own answer here, so hits that answer an
 * older query can be told from the ones the query on screen asked for.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import { fakeIndexPort, type SearchHit } from '@dfai/application';
import { createOverlayStore } from '../overlay-store.ts';
import { useSearch } from './use-search.ts';

const hit = (title: string): SearchHit => ({
  path: createVaultPath(`Notes/${title}.md`),
  title,
  snippet: '',
});

/** The answer to each query, by what was typed; anything else finds nothing. */
const ANSWERS: Readonly<Record<string, readonly string[]>> = {
  ledger: ['Ledger April', 'Ledger May', 'Ledger June'],
  garden: ['Garden Plan', 'Garden Beds'],
  // The second query's hits hold the first's top hit, but not at the top.
  note: ['Note Alpha', 'Note Beta'],
  notes: ['Notes Index', 'Note Alpha'],
};

function answeringIndex() {
  const asked: string[] = [];
  const index = fakeIndexPort({
    search: async (query: string) => {
      asked.push(query);
      const typed = query.replace(/["*]/g, '');
      return (ANSWERS[typed] ?? []).map(hit);
    },
  });
  return { index, asked };
}

function palette(initialKey = 'ready:1') {
  const { index, asked } = answeringIndex();
  const store = createOverlayStore();
  const hook = renderHook(
    ({ changeKey }: { changeKey: string }) => useSearch({ index, changeKey, store }),
    {
      initialProps: { changeKey: initialKey },
    },
  );
  return { hook, asked };
}

const titles = (hits: readonly SearchHit[]) => hits.map((found) => found.title);

describe('useSearch — typing while the index is building (#239)', () => {
  it('starts a new query at its top hit, not on the old query top hit it also matches', async () => {
    const { hook } = palette();
    act(() => hook.result.current.setQuery('note'));
    await waitFor(() =>
      expect(titles(hook.result.current.hits)).toEqual(['Note Alpha', 'Note Beta']),
    );
    expect(hook.result.current.selected).toBe(0);

    act(() => hook.result.current.setQuery('notes'));
    await waitFor(() =>
      expect(titles(hook.result.current.hits)).toEqual(['Notes Index', 'Note Alpha']),
    );

    // A different query is a fresh list: Enter opens its first hit.
    expect(hook.result.current.hits[hook.result.current.selected]?.title).toBe('Notes Index');
  });

  it('shows no hits that answered another query while a query typed during a build waits', async () => {
    const { hook } = palette();
    act(() => hook.result.current.setQuery('ledger'));
    await waitFor(() => expect(hook.result.current.hits).toHaveLength(3));

    hook.rerender({ changeKey: 'building' });
    act(() => hook.result.current.setQuery('garden'));
    await act(async () => {});

    // The ledgers do not match "garden": Enter here would open Ledger April.
    expect(hook.result.current.query).toBe('garden');
    expect(titles(hook.result.current.hits)).not.toContain('Ledger April');
  });

  it('answers the query typed during a build once the index is ready, and starts it at the top', async () => {
    const { hook, asked } = palette();
    act(() => hook.result.current.setQuery('ledger'));
    await waitFor(() => expect(hook.result.current.hits).toHaveLength(3));
    act(() => hook.result.current.move(1));

    hook.rerender({ changeKey: 'building' });
    act(() => hook.result.current.setQuery('garden'));
    await act(async () => {});
    expect(asked).toHaveLength(1);

    hook.rerender({ changeKey: 'ready:2' });
    await waitFor(() =>
      expect(titles(hook.result.current.hits)).toEqual(['Garden Plan', 'Garden Beds']),
    );
    expect(hook.result.current.selected).toBe(0);
  });

  it('asks nothing of an index that opens building, and answers once it is ready', async () => {
    const { hook, asked } = palette('building');
    act(() => hook.result.current.setQuery('ledger'));
    await act(async () => {});
    expect(asked).toHaveLength(0);
    expect(hook.result.current.hits).toHaveLength(0);

    hook.rerender({ changeKey: 'ready:1' });
    await waitFor(() => expect(hook.result.current.hits).toHaveLength(3));
    expect(asked).toHaveLength(1);
  });

  it('drops an answer begun on ready when a rebuild starts before it lands, and answers again after', async () => {
    const { hook, asked } = palette();
    act(() => hook.result.current.setQuery('ledger'));
    await waitFor(() => expect(hook.result.current.hits).toHaveLength(3));
    act(() => hook.result.current.move(1));
    act(() => hook.result.current.move(1));

    // ready:2's search is asked, then a rebuild begins before it answers, then ready:3.
    act(() => hook.rerender({ changeKey: 'ready:2' }));
    act(() => hook.rerender({ changeKey: 'building' }));
    act(() => hook.rerender({ changeKey: 'ready:3' }));
    await waitFor(() => expect(asked).toHaveLength(3));
    await act(async () => {});

    expect(titles(hook.result.current.hits)).toEqual(['Ledger April', 'Ledger May', 'Ledger June']);
    // The same query: the person's place is kept through the flip.
    expect(hook.result.current.hits[hook.result.current.selected]?.title).toBe('Ledger June');
  });
});
