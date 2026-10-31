// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeIndexPort, type SearchHit, type SearchScope } from '@dfai/application';
import { changePalette, createOverlayStore } from '../overlay-store.ts';
import { useSearch } from './use-search.ts';

const NOTE: SearchHit = { path: 'Library/Art.md', title: 'Art', snippet: '<<war>>' };
const FIRST: SearchHit = { ...NOTE, snippet: '<<war>> one', block: 'aaaaa1' };
const SECOND: SearchHit = { ...NOTE, snippet: '<<war>> two', block: 'bbbbb2' };

describe('useSearch with highlights (#507)', () => {
  it('asks the index for the highlights in literature notes too', async () => {
    const scopes: (SearchScope | undefined)[] = [];
    const index = fakeIndexPort({
      search: async (_query, _limit, scope) => {
        scopes.push(scope);
        return [];
      },
    });
    const store = createOverlayStore();
    const { result } = renderHook(() => useSearch({ index, changeKey: 'ready:1', store }));
    act(() => result.current.setQuery('war'));
    await waitFor(() => expect(scopes).toHaveLength(1));
    expect(scopes[0]).toEqual({ skipPrefix: 'archive/', highlights: true });
  });

  it('keeps the chosen highlight chosen when the same search is answered again, though its note matches twice', async () => {
    let held: SearchHit[] = [NOTE, FIRST, SECOND];
    const index = fakeIndexPort({ search: async () => [...held] });
    const store = createOverlayStore();
    const { result, rerender } = renderHook(
      ({ changeKey }: { changeKey: string }) => useSearch({ index, changeKey, store }),
      { initialProps: { changeKey: 'ready:1' } },
    );
    act(() => result.current.setQuery('war'));
    await waitFor(() => expect(result.current.hits).toHaveLength(3));
    act(() => changePalette(store, (input) => ({ ...input, selected: 2 })));

    // The index has news: the first highlight is gone, the second moves up a place.
    held = [NOTE, SECOND];
    rerender({ changeKey: 'ready:2' });
    await waitFor(() => expect(result.current.hits).toHaveLength(2));
    expect(result.current.selected).toBe(1);
    expect(result.current.hits[result.current.selected]).toEqual(SECOND);
  });
});
