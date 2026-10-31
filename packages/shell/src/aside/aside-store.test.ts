// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import {
  clearRow,
  createAsideStore,
  focusRow,
  hideAside,
  loadVaultAside,
  selectAsideTab,
  setAsideFolded,
  showAsideTab,
  toggleAside,
  toggleClaude,
  useAsideOpen,
  useAsideShown,
  useClaudeAsked,
  useClaudeShown,
  useFocusedRow,
  withinOf,
  type RememberedAside,
  type RememberedAsides,
} from './aside-store.ts';

/** A remembered store over a map, with the writes counted. */
function remembering(initial: Record<string, RememberedAside> = {}) {
  const held = new Map(Object.entries(initial));
  const remembered: RememberedAsides = {
    read: vi.fn((vaultKey: string) => held.get(vaultKey) ?? null),
    write: vi.fn(({ vaultKey, aside }) => {
      held.set(vaultKey, aside);
    }),
  };
  return { remembered, held };
}

const task = createVaultPath('Tasks/Ship it.md');
const book = createVaultPath('Books/Dune.md');

describe('the aside store', () => {
  it('opens a vault with nothing remembered shut, on Properties', () => {
    const store = createAsideStore(remembering());
    loadVaultAside(store, '/v');
    expect(store.getState()).toMatchObject({ vault: '/v', open: false, tab: 'properties' });
  });

  it('reads what the vault remembered, and the other vault its own', () => {
    const store = createAsideStore(
      remembering({
        '/a': { open: true, tab: 'outline' },
        '/b': { open: false, tab: 'claude' },
      }),
    );
    loadVaultAside(store, '/a');
    expect(store.getState()).toMatchObject({ open: true, tab: 'outline' });
    loadVaultAside(store, '/b');
    expect(store.getState()).toMatchObject({ open: false, tab: 'claude' });
  });

  it('remembers a toggle and a tab change under the open vault, and nothing with no vault', () => {
    const { remembered, held } = remembering();
    const store = createAsideStore({ remembered });
    toggleAside(store);
    expect(remembered.write).not.toHaveBeenCalled();

    loadVaultAside(store, '/v');
    toggleAside(store);
    expect(held.get('/v')).toEqual({ open: true, tab: 'properties' });
    selectAsideTab(store, 'backlinks');
    expect(held.get('/v')).toEqual({ open: true, tab: 'backlinks' });
    hideAside(store);
    expect(held.get('/v')).toEqual({ open: false, tab: 'backlinks' });
  });

  it('writes nothing for a change that changes nothing', () => {
    const { remembered } = remembering();
    const store = createAsideStore({ remembered });
    loadVaultAside(store, '/v');
    hideAside(store);
    selectAsideTab(store, 'properties');
    expect(remembered.write).not.toHaveBeenCalled();
  });

  it('opening the vault already open changes nothing', () => {
    const { remembered } = remembering();
    const store = createAsideStore({ remembered });
    loadVaultAside(store, '/v');
    toggleAside(store);
    loadVaultAside(store, '/v');
    expect(store.getState().open).toBe(true);
    expect(remembered.read).toHaveBeenCalledTimes(1);
  });

  it('⌘J brings the aside up on Claude, and takes it down from Claude only', () => {
    const store = createAsideStore(remembering());
    loadVaultAside(store, '/v');
    const { result } = renderHook(() => useClaudeShown(store));
    expect(result.current).toBe(false);

    toggleClaude(store);
    expect(store.getState()).toMatchObject({ open: true, tab: 'claude' });
    toggleClaude(store);
    expect(store.getState().open).toBe(false);

    // Open on Properties, ⌘J shows Claude rather than closing.
    showAsideTab(store, 'properties');
    toggleClaude(store);
    expect(store.getState()).toMatchObject({ open: true, tab: 'claude' });
  });

  it('holds the focused row by tab, against the page it was focused on', () => {
    const store = createAsideStore(remembering());
    loadVaultAside(store, '/v');
    focusRow(store, { tab: 't1', path: task, within: 'type:task' });

    const onPage = renderHook(() => useFocusedRow(store, { tab: 't1', within: 'type:task' }));
    expect(onPage.result.current).toBe(task);
    const movedOn = renderHook(() => useFocusedRow(store, { tab: 't1', within: book }));
    expect(movedOn.result.current).toBeNull();
    const otherTab = renderHook(() => useFocusedRow(store, { tab: 't2', within: 'type:task' }));
    expect(otherTab.result.current).toBeNull();
  });

  it('the same row focused again does not change the state', () => {
    const store = createAsideStore(remembering());
    focusRow(store, { tab: 't1', path: task, within: 'type:task' });
    const before = store.getState();
    focusRow(store, { tab: 't1', path: task, within: 'type:task' });
    expect(store.getState()).toBe(before);
    focusRow(store, { tab: 't1', path: book, within: 'type:task' });
    expect(store.getState().rows.get('t1')?.path).toBe(book);
  });

  it('another vault starts with no focused rows', () => {
    const store = createAsideStore(remembering());
    loadVaultAside(store, '/a');
    focusRow(store, { tab: 't1', path: task, within: 'type:task' });
    loadVaultAside(store, '/b');
    expect(store.getState().rows.size).toBe(0);
  });

  it('a subscriber to open is not told of a row focus', () => {
    const store = createAsideStore(remembering());
    const { result } = renderHook(() => useAsideOpen(store));
    const seen = result.current;
    focusRow(store, { tab: 't1', path: task, within: 'type:task' });
    expect(result.current).toBe(seen);
  });

  it('names the page a table is on', () => {
    expect(withinOf({ kind: 'note', path: task })).toBe(task);
    expect(withinOf({ kind: 'type', name: 'task' })).toBe('type:task');
    expect(withinOf({ kind: 'today' })).toBe('today');
    expect(withinOf(null)).toBeNull();
  });
});

describe('the aside store, let go and folded (#387 review)', () => {
  it('lets a tab’s row go, and a tab holding none is left as it is', () => {
    const store = createAsideStore(remembering());
    focusRow(store, { tab: 't1', path: task, within: 'type:task' });
    const before = store.getState();
    clearRow(store, 't2');
    expect(store.getState()).toBe(before);
    clearRow(store, 't1');
    expect(store.getState().rows.has('t1')).toBe(false);
  });

  it('folded by the window hides what open remembers, and remembers nothing for it', () => {
    const { remembered } = remembering();
    const store = createAsideStore({ remembered });
    loadVaultAside(store, '/v');
    toggleAside(store);
    const { result } = renderHook(() => useAsideShown(store));
    expect(result.current).toBe(true);
    act(() => setAsideFolded(store, true));
    expect(result.current).toBe(false);
    expect(store.getState().open).toBe(true);
    expect(remembered.write).toHaveBeenCalledTimes(1);
    act(() => setAsideFolded(store, false));
    expect(result.current).toBe(true);
  });
});

describe('the aside store, folded by the window (#387 verification)', () => {
  it('Claude is not shown while the window folds the aside, whatever open remembers', () => {
    const store = createAsideStore(remembering());
    loadVaultAside(store, '/v');
    toggleClaude(store);
    const { result } = renderHook(() => useClaudeShown(store));
    expect(result.current).toBe(true);
    act(() => setAsideFolded(store, true));
    expect(result.current).toBe(false);
  });

  it('asked for while folded, the aside opens rather than closing: the ask decides on what is shown', () => {
    const store = createAsideStore(remembering());
    loadVaultAside(store, '/v');
    toggleClaude(store);
    setAsideFolded(store, true);
    toggleClaude(store);
    expect(store.getState()).toMatchObject({ open: true, tab: 'claude' });
    setAsideFolded(store, false);
    toggleClaude(store);
    expect(store.getState().open).toBe(false);

    toggleAside(store);
    setAsideFolded(store, true);
    toggleAside(store);
    expect(store.getState().open).toBe(true);
  });

  it('knows whether Claude was asked for, as against remembered across a launch', () => {
    const store = createAsideStore(remembering({ '/v': { open: true, tab: 'claude' } }));
    loadVaultAside(store, '/v');
    const { result } = renderHook(() => useClaudeAsked(store));
    expect(result.current).toBe(false);
    act(() => hideAside(store));
    act(() => toggleClaude(store));
    expect(result.current).toBe(true);
    act(() => selectAsideTab(store, 'properties'));
    act(() => selectAsideTab(store, 'claude'));
    expect(result.current).toBe(true);
    act(() => loadVaultAside(store, '/w'));
    expect(result.current).toBe(false);
  });
});
