// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  EmbeddingError,
  fakeIndexPort,
  type SemanticHit,
  type SemanticQuery,
} from '@dfai/application';
import type { MeaningSource } from '../semantic/use-semantic-key.ts';
import { createOverlayStore } from '../overlay-store.ts';
import { useSearch } from './use-search.ts';

const hit = (path: string, block: string | null, text: string): SemanticHit => ({
  path,
  title: path.replace('.md', ''),
  text,
  heading: null,
  block,
  link: `[[${path}]]`,
  score: 0.5,
});

/** An engine whose build never moves. */
const idleBuild = {
  subscribe: () => () => undefined,
  progress: () => ({ done: 0, total: 0, failure: null }),
};

function semanticOf(hits: readonly SemanticHit[]) {
  const asked: SemanticQuery[] = [];
  const semantic: MeaningSource = {
    search: async (query) => {
      asked.push(query);
      return { hits, progress: { done: 2, total: 5, failure: null } };
    },
    ...idleBuild,
  };
  return { asked, semantic };
}

describe('useSearch by meaning (P32-02)', () => {
  it('asks the vault by meaning once it is switched on, and shows each place once', async () => {
    let wordSearches = 0;
    const index = fakeIndexPort({
      search: async () => {
        wordSearches += 1;
        return [];
      },
    });
    const { asked, semantic } = semanticOf([
      hit('Standup.md', null, 'Pay day moves to Friday.'),
      hit('Standup.md', null, 'Payroll is late.'),
      hit('Standup.md', 'k3x9a1', 'Wages go up.'),
      hit('Garden.md', null, 'Bees.'),
    ]);
    const store = createOverlayStore();
    const { result } = renderHook(() => useSearch({ index, semantic, store }));

    act(() => result.current.setByMeaning(true));
    act(() => result.current.setQuery('when are wages paid?'));

    await waitFor(() => expect(result.current.hits).toHaveLength(3));
    expect(asked.at(-1)).toEqual({
      query: 'when are wages paid?',
      limit: 60,
      includeArchived: false,
    });
    expect(wordSearches).toBe(0);
    expect(result.current.hits).toEqual([
      { path: 'Standup.md', title: 'Standup', snippet: 'Pay day moves to Friday.' },
      { path: 'Standup.md', title: 'Standup', snippet: 'Wages go up.', block: 'k3x9a1' },
      { path: 'Garden.md', title: 'Garden', snippet: 'Bees.' },
    ]);
    expect(result.current.meaning).toEqual({
      progress: { done: 2, total: 5, failure: null },
      problem: null,
    });
  });

  it('searches by words again once it is switched off', async () => {
    let wordSearches = 0;
    const index = fakeIndexPort({
      search: async () => {
        wordSearches += 1;
        return [{ path: 'A.md', title: 'A', snippet: '<<pay>>' }];
      },
    });
    const store = createOverlayStore();
    const { semantic } = semanticOf([]);
    const { result } = renderHook(() => useSearch({ index, semantic, store }));
    act(() => result.current.setByMeaning(true));
    act(() => result.current.setQuery('pay'));
    act(() => result.current.setByMeaning(false));
    await waitFor(() => expect(result.current.hits).toHaveLength(1));
    expect(wordSearches).toBeGreaterThan(0);
    expect(result.current.byMeaning).toBe(false);
    expect(result.current.meaning).toBeNull();
  });

  it('says why when the search by meaning cannot run', async () => {
    const semantic: MeaningSource = {
      search: async () => {
        throw new EmbeddingError('the model could not be fetched: no network');
      },
      ...idleBuild,
    };
    const store = createOverlayStore();
    const index = fakeIndexPort();
    const { result } = renderHook(() => useSearch({ index, semantic, store }));
    act(() => result.current.setByMeaning(true));
    act(() => result.current.setQuery('pay'));
    await waitFor(() =>
      expect(result.current.meaning?.problem).toBe('the model could not be fetched: no network'),
    );
    expect(result.current.hits).toEqual([]);
  });

  it('is not offered, and searches by words, where the vault has no semantic search', async () => {
    let wordSearches = 0;
    const index = fakeIndexPort({
      search: async () => {
        wordSearches += 1;
        return [];
      },
    });
    const store = createOverlayStore();
    const { result } = renderHook(() => useSearch({ index, semantic: null, store }));
    act(() => result.current.setByMeaning(true));
    act(() => result.current.setQuery('pay'));
    await waitFor(() => expect(wordSearches).toBe(1));
    expect(result.current.byMeaning).toBe(false);
  });

  it('asks once for a question typed quickly, not for each letter on the way', async () => {
    const index = fakeIndexPort();
    const { asked, semantic } = semanticOf([hit('Garden.md', null, 'Bees.')]);
    const store = createOverlayStore();
    const { result } = renderHook(() => useSearch({ index, semantic, store }));
    act(() => result.current.setByMeaning(true));
    act(() => result.current.setQuery('w'));
    act(() => result.current.setQuery('wa'));
    act(() => result.current.setQuery('wag'));
    await waitFor(() => expect(result.current.hits).toHaveLength(1));
    expect(asked.map((each) => each.query)).toEqual(['wag']);
  });

  it('asks for three times the rows and cuts to twenty once places are one row each', async () => {
    const index = fakeIndexPort();
    // Forty blocks of two notes with no ids: two places, so two rows, whatever the limit.
    const blocks = Array.from({ length: 40 }, (_, at) =>
      hit(`N${at % 2}.md`, null, `Block ${at}.`),
    );
    const { asked, semantic } = semanticOf(blocks);
    const store = createOverlayStore();
    const { result } = renderHook(() => useSearch({ index, semantic, store }));
    act(() => result.current.setByMeaning(true));
    act(() => result.current.setQuery('block'));
    await waitFor(() => expect(result.current.hits).toHaveLength(2));
    expect(asked.at(-1)?.limit).toBe(60);
    const many = Array.from({ length: 60 }, (_, at) => hit(`N${at}.md`, null, `Block ${at}.`));
    const full = semanticOf(many);
    const otherStore = createOverlayStore();
    const second = renderHook(() =>
      useSearch({ index, semantic: full.semantic, store: otherStore }),
    );
    act(() => second.result.current.setByMeaning(true));
    act(() => second.result.current.setQuery('block'));
    await waitFor(() => expect(second.result.current.hits).toHaveLength(20));
  });
});
