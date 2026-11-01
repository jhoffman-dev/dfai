// @vitest-environment jsdom
/**
 * Attacks on ⌘K re-searching when the index changes (#240): the palette is
 * open, the person is arrowing through the results, and the index moves on
 * under them — an autosave's echo, a sync pull.
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

const LEDGERS = ['Ledger April', 'Ledger May', 'Ledger June', 'Ledger July', 'Ledger August'].map(
  hit,
);

/** An index that always finds the same five ledgers, and counts what it was asked. */
function ledgerIndex() {
  const asked = { count: 0 };
  const index = fakeIndexPort({
    search: async () => {
      asked.count += 1;
      return [...LEDGERS];
    },
  });
  return { index, asked };
}

function palette(index: ReturnType<typeof ledgerIndex>['index']) {
  let renders = 0;
  const store = createOverlayStore();
  const hook = renderHook(
    ({ changeKey }: { changeKey: string }) => {
      renders += 1;
      return useSearch({ index, changeKey, store });
    },
    { initialProps: { changeKey: 'ready:1' } },
  );
  return { hook, renders: () => renders };
}

describe('useSearch — the index changes while the palette is open', () => {
  it('keeps the result the person arrowed to when the index changes and the same notes still match', async () => {
    const { index, asked } = ledgerIndex();
    const { hook } = palette(index);
    act(() => hook.result.current.setQuery('ledger'));
    await waitFor(() => expect(hook.result.current.hits).toHaveLength(5));

    // Down three times: the fourth result, Ledger July, is the one Enter opens.
    act(() => hook.result.current.move(1));
    act(() => hook.result.current.move(1));
    act(() => hook.result.current.move(1));
    expect(hook.result.current.hits[hook.result.current.selected]?.title).toBe('Ledger July');

    // An autosave's watcher echo re-indexes one note; the same five still match.
    hook.rerender({ changeKey: 'ready:2' });
    await waitFor(() => expect(asked.count).toBe(2));
    await act(async () => {});

    expect(hook.result.current.hits[hook.result.current.selected]?.title).toBe('Ledger July');
  });

  it('does not search an index that is still building, which reads it half written (#135)', async () => {
    const { index, asked } = ledgerIndex();
    const { hook } = palette(index);
    act(() => hook.result.current.setQuery('ledger'));
    await waitFor(() => expect(asked.count).toBe(1));

    hook.rerender({ changeKey: 'building' });
    await act(async () => {});

    expect(asked.count).toBe(1);
  });

  it('runs one search per settled index, not two, through a sync pull of ten re-indexes', async () => {
    const { index, asked } = ledgerIndex();
    const { hook } = palette(index);
    act(() => hook.result.current.setQuery('ledger'));
    await waitFor(() => expect(asked.count).toBe(1));

    for (let revision = 2; revision <= 11; revision += 1) {
      hook.rerender({ changeKey: 'building' });
      await act(async () => {});
      hook.rerender({ changeKey: `ready:${revision}` });
      await act(async () => {});
    }

    expect(asked.count).toBeLessThanOrEqual(11);
  });

  it('never shows an older answer for the query on screen when answers arrive out of order', async () => {
    const answers: Array<() => void> = [];
    const index = fakeIndexPort({
      search: (query) =>
        new Promise<SearchHit[]>((resolve) => {
          answers.push(() => resolve([hit(`for ${query}`)]));
        }),
    });
    const store = createOverlayStore();
    const hook = renderHook(
      ({ changeKey }: { changeKey: string }) => useSearch({ index, changeKey, store }),
      { initialProps: { changeKey: 'ready:1' } },
    );
    act(() => hook.result.current.setQuery('led'));
    hook.rerender({ changeKey: 'ready:2' });
    act(() => hook.result.current.setQuery('ledger'));
    await waitFor(() => expect(answers).toHaveLength(3));

    // The newest answers first, then the oldest, for the first query.
    await act(async () => answers[2]?.());
    await act(async () => answers[1]?.());
    await act(async () => answers[0]?.());

    expect(hook.result.current.hits.map((each) => each.title)).toEqual(['for "ledger"*']);
  });
});

describe('useSearch — the palette closed, its query empty', () => {
  it('neither searches nor renders again when the index changes', async () => {
    const { index, asked } = ledgerIndex();
    const { hook, renders } = palette(index);
    await act(async () => {});
    const before = renders();

    hook.rerender({ changeKey: 'ready:2' });
    await act(async () => {});

    expect(asked.count).toBe(0);
    // The rerender itself, and nothing the hook set in its wake.
    expect(renders() - before).toBe(1);
  });
});
