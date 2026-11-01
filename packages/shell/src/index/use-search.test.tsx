// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import { fakeIndexPort, type SearchHit } from '@dfai/application';
import { createOverlayStore } from '../overlay-store.ts';
import { useSearch } from './use-search.ts';

const NEW_NOTE: SearchHit = {
  path: createVaultPath('Untitled.md'),
  title: 'Untitled',
  snippet: '',
};

describe('useSearch', () => {
  it('searches again when the index changes under a query already typed', async () => {
    // A note made a moment ago is indexed after the palette has already asked.
    const held: SearchHit[] = [];
    let asked = 0;
    const index = fakeIndexPort({
      search: async () => {
        asked += 1;
        return [...held];
      },
    });
    const store = createOverlayStore();
    const { result, rerender } = renderHook(
      ({ changeKey }: { changeKey: string }) => useSearch({ index, changeKey, store }),
      { initialProps: { changeKey: 'ready:1' } },
    );

    act(() => result.current.setQuery('Untitled'));
    await waitFor(() => expect(asked).toBe(1));
    expect(result.current.hits).toEqual([]);

    held.push(NEW_NOTE);
    rerender({ changeKey: 'ready:2' });

    await waitFor(() => expect(result.current.hits).toEqual([NEW_NOTE]));
  });
});
