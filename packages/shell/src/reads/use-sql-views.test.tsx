// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import type { DefinedType } from '@dfai/application';
import { useSqlViews } from './use-sql-views.ts';
import { createIndexStatusStore } from '../index/index-status-store.ts';

const status = createIndexStatusStore();

const book: DefinedType = {
  name: 'book',
  label: 'Book',
  properties: [],
  path: createVaultPath('.atlas/types/book.md'),
};

describe('the SQL views behind the types', () => {
  it('are built once the index is ready, and again only for new definitions or a new build', () => {
    const rebuildViews = vi.fn(async () => {});
    const types = [book];
    // Held across renders, as the window holds its index.
    const index = { rebuildViews };
    const hook = renderHook((props) => useSqlViews({ index, ...props }), {
      initialProps: { types, ready: false, status },
    });
    expect(rebuildViews).not.toHaveBeenCalled();

    hook.rerender({ types, ready: true, status });
    expect(rebuildViews).toHaveBeenCalledTimes(1);

    // The same definitions, drawn again: nothing to rebuild.
    hook.rerender({ types, ready: true, status });
    expect(rebuildViews).toHaveBeenCalledTimes(1);

    const renamed = [{ ...book, label: 'Books' }];
    hook.rerender({ types: renamed, ready: true, status });
    expect(rebuildViews).toHaveBeenCalledTimes(2);

    // A rebuild of the index makes the database afresh, without its views.
    hook.rerender({ types: renamed, ready: false, status });
    expect(rebuildViews).toHaveBeenCalledTimes(2);
    hook.rerender({ types: renamed, ready: true, status });
    expect(rebuildViews).toHaveBeenCalledTimes(3);
  });

  it('are not built for a vault with no types', () => {
    const rebuildViews = vi.fn(async () => {});
    renderHook(() => useSqlViews({ index: { rebuildViews }, types: [], ready: true, status }));
    expect(rebuildViews).not.toHaveBeenCalled();
  });

  it('tries a failed rebuild again when the index next has news, and only then, drawing nothing', async () => {
    const rebuildViews = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValue(undefined);
    const index = { rebuildViews };
    const types = [book];
    const news = createIndexStatusStore();
    let draws = 0;
    renderHook(() => {
      draws += 1;
      useSqlViews({ index, types, ready: true, status: news });
    });
    await act(async () => {});
    expect(rebuildViews).toHaveBeenCalledTimes(1);

    await act(async () => news.setState({ revision: 2 }));
    expect(rebuildViews).toHaveBeenCalledTimes(2);

    // It worked: more news is nothing to rebuild for.
    await act(async () => news.setState({ revision: 3 }));
    expect(rebuildViews).toHaveBeenCalledTimes(2);
    // Heard, not drawn: the window holding it is not drawn for the index's news (#326).
    expect(draws).toBe(1);
  });
});
