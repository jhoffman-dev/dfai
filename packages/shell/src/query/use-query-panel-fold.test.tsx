// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { QueryPanelFoldStore } from '@dfai/ui';
import { useQueryPanelFold } from './use-query-panel-fold.ts';

/** A store held in a map, as localStorage would hold it. */
function memoryStore(seed: Record<string, boolean> = {}) {
  const held = new Map(Object.entries(seed));
  const store: QueryPanelFoldStore = {
    read: (view) => held.get(view) ?? null,
    write: (view, collapsed) => {
      held.set(view, collapsed);
    },
  };
  return { store, held };
}

const SAVED = 'FROM task GROUP BY status';

describe('useQueryPanelFold', () => {
  it('folds a saved query the first time its view is opened', () => {
    const { store } = memoryStore();
    const { result } = renderHook(() =>
      useQueryPanelFold({ store, view: 'open-work', savedText: SAVED }),
    );
    expect(result.current.collapsed).toBe(true);
  });

  it('opens the builder for a view whose query is still empty', () => {
    const { store } = memoryStore();
    const { result } = renderHook(() =>
      useQueryPanelFold({ store, view: 'new-view', savedText: '  ' }),
    );
    expect(result.current.collapsed).toBe(false);
  });

  it('opens and folds the query, remembering it at once', () => {
    const { store, held } = memoryStore();
    const { result } = renderHook(() =>
      useQueryPanelFold({ store, view: 'open-work', savedText: SAVED }),
    );
    act(() => result.current.onToggle());
    expect(result.current.collapsed).toBe(false);
    expect(held.get('open-work')).toBe(false);
    act(() => result.current.onToggle());
    expect(result.current.collapsed).toBe(true);
    expect(held.get('open-work')).toBe(true);
  });

  it('opens a view as it was left, over what its query would say', () => {
    const { store } = memoryStore({ 'open-work': false, 'new-view': true });
    const opened = renderHook(() =>
      useQueryPanelFold({ store, view: 'open-work', savedText: SAVED }),
    );
    expect(opened.result.current.collapsed).toBe(false);
    const folded = renderHook(() => useQueryPanelFold({ store, view: 'new-view', savedText: '' }));
    expect(folded.result.current.collapsed).toBe(true);
  });

  it('keeps the builder open when a new view’s query is first saved', () => {
    const { store } = memoryStore();
    const { result, rerender } = renderHook(
      ({ savedText }) => useQueryPanelFold({ store, view: 'new-view', savedText }),
      { initialProps: { savedText: '' } },
    );
    expect(result.current.collapsed).toBe(false);
    // Save writes the query to the file: the view stays as it is, mid-edit.
    rerender({ savedText: SAVED });
    expect(result.current.collapsed).toBe(false);
  });

  it('folds a saved query once its file is read, not before', () => {
    const { store } = memoryStore();
    const { result, rerender } = renderHook(
      ({ savedText }) => useQueryPanelFold({ store, view: 'open-work', savedText }),
      { initialProps: { savedText: null as string | null } },
    );
    // The pane shows the view before its file has been read: nothing to decide yet.
    rerender({ savedText: SAVED });
    expect(result.current.collapsed).toBe(true);
  });

  it('reads another view’s fold when the pane opens it', () => {
    const { store } = memoryStore({ waiting: false });
    const { result, rerender } = renderHook(
      ({ view }) => useQueryPanelFold({ store, view, savedText: SAVED }),
      { initialProps: { view: 'open-work' } },
    );
    expect(result.current.collapsed).toBe(true);
    rerender({ view: 'waiting' });
    expect(result.current.collapsed).toBe(false);
    act(() => result.current.onToggle());
    rerender({ view: 'open-work' });
    expect(result.current.collapsed).toBe(true);
    rerender({ view: 'waiting' });
    expect(result.current.collapsed).toBe(true);
  });
});
