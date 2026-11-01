// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createVaultPath, MAX_PANES, type NavigationPlace, type Workspace } from '@dfai/domain';
import {
  createWorkspaceStore,
  loadVault,
  openPlace,
  setPanesFit,
  splitPane,
  toggleSplit,
  useCanSplit,
  usePaneKeys,
  usePanesFit,
  workspaceNow,
  type RememberedWorkspaces,
} from './workspace-store.ts';

/**
 * How many panes the window has room for (#658): the store draws only that
 * many and offers no split, but keeps every pane the workspace holds.
 */

const note = (name: string): NavigationPlace => ({
  kind: 'note',
  path: createVaultPath(`${name}.md`),
});

function openOn() {
  const writes: Workspace[] = [];
  const remembered: RememberedWorkspaces = {
    read: () => null,
    write: ({ workspace }) => writes.push(workspace),
  };
  const store = createWorkspaceStore({ remembered });
  loadVault(store, '/v');
  return { store, writes };
}

const placesOf = (ws: Workspace, pane = 0) =>
  ws.panes[pane]?.tabs.map((tab) => tab.history.current) ?? [];

describe('how many panes fit', () => {
  it('starts with room for every pane, and is told otherwise without a write', () => {
    const { store, writes } = openOn();
    expect(store.getState().panesFit).toBe(MAX_PANES);
    const written = writes.length;
    setPanesFit(store, 1);
    expect(store.getState().panesFit).toBe(1);
    expect(writes).toHaveLength(written);
  });

  it('does not set the same answer again, so nothing subscribed draws', () => {
    const { store } = openOn();
    let told = 0;
    store.subscribe(() => (told += 1));
    setPanesFit(store, MAX_PANES);
    expect(told).toBe(0);
    setPanesFit(store, 1);
    expect(told).toBe(1);
  });

  it('opens a split as a new tab where one pane fits', () => {
    const { store } = openOn();
    openPlace(store, note('a'), 'here');
    setPanesFit(store, 1);
    openPlace(store, note('b'), 'split');
    const ws = workspaceNow(store);
    expect(ws.panes).toHaveLength(1);
    expect(placesOf(ws)).toEqual([note('a'), note('b')]);
  });

  it('neither splits nor closes a pane from the split commands where one pane fits', () => {
    const { store } = openOn();
    openPlace(store, note('a'), 'here');
    setPanesFit(store, 1);
    splitPane(store);
    toggleSplit(store);
    expect(workspaceNow(store).panes).toHaveLength(1);
  });

  it('keeps both panes, their keys and their tabs, when the room for the second goes', () => {
    const { store } = openOn();
    openPlace(store, note('a'), 'here');
    toggleSplit(store);
    openPlace(store, note('b'), 'new-tab');
    const before = workspaceNow(store);
    const keys = store.getState().paneKeys;

    setPanesFit(store, 1);
    expect(workspaceNow(store)).toBe(before);
    expect(store.getState().paneKeys).toBe(keys);
    // The pane that is hidden cannot be closed by the key that would close it unseen.
    toggleSplit(store);
    expect(workspaceNow(store).panes).toHaveLength(2);

    setPanesFit(store, MAX_PANES);
    expect(workspaceNow(store)).toBe(before);
    toggleSplit(store);
    expect(workspaceNow(store).panes).toHaveLength(1);
  });

  it('tells the panes how many fit and the bar whether it may offer a split', () => {
    const { store } = openOn();
    const fit = renderHook(() => usePanesFit(store));
    const canSplit = renderHook(() => useCanSplit(store));
    const keys = renderHook(() => usePaneKeys(store));
    expect(fit.result.current).toBe(MAX_PANES);
    expect(canSplit.result.current).toBe(true);

    setPanesFit(store, 1);
    fit.rerender();
    canSplit.rerender();
    expect(fit.result.current).toBe(1);
    expect(canSplit.result.current).toBe(false);
    // The panes themselves are the same: nothing was closed.
    expect(keys.result.current).toEqual([0]);

    setPanesFit(store, MAX_PANES);
    toggleSplit(store);
    canSplit.rerender();
    expect(canSplit.result.current).toBe(false);
  });
});
