// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import { fakeIndexPort, type SearchHit } from '@dfai/application';
import { createOverlayStore, showOverlay } from '../overlay-store.ts';
import { useSearch } from './use-search.ts';

const hit = (name: string): SearchHit => ({
  path: createVaultPath(`${name}.md`),
  title: name,
  snippet: '',
});
const BREAD = hit('Bread');
const BUNS = hit('Buns');
const BAGELS = hit('Bagels');

describe('useSearch over the overlay store (#261, attack)', () => {
  it('never draws a chosen row from one answer against the hits of another', async () => {
    // The answer lands in React state and the kept place in the store: if the
    // two are drawn apart, a frame shows the new place against the old hits.
    let answer: SearchHit[] = [BREAD, BUNS, BAGELS];
    const index = fakeIndexPort({ search: async () => [...answer] });
    const store = createOverlayStore();
    showOverlay(store, 'search');
    const drawn: { hits: string[]; chosen: string | undefined }[] = [];
    const { result, rerender } = renderHook(
      ({ changeKey }: { changeKey: string }) => {
        const search = useSearch({ index, changeKey, store });
        drawn.push({
          hits: search.hits.map((h) => h.title),
          chosen: search.hits[search.selected]?.title,
        });
        return search;
      },
      { initialProps: { changeKey: 'ready:1' } },
    );
    act(() => result.current.setQuery('b'));
    await waitFor(() => expect(result.current.hits).toHaveLength(3));
    act(() => result.current.move(2));
    expect(result.current.hits[result.current.selected]).toEqual(BAGELS);

    // The index moves: Bagels is now the only match, so the place follows it to row 0.
    answer = [BAGELS];
    drawn.length = 0;
    rerender({ changeKey: 'ready:2' });
    await waitFor(() => expect(result.current.hits).toEqual([BAGELS]));

    expect(result.current.hits[result.current.selected]).toEqual(BAGELS);
    // Every frame drawn while it moved still has Bagels chosen.
    expect(drawn.filter((frame) => frame.chosen !== 'Bagels')).toEqual([]);
  });
});
