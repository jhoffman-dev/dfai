// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  activeTabOf,
  createVaultPath,
  EMPTY_WORKSPACE,
  openInActiveTab,
  splitWithTab,
} from '@dfai/domain';
import {
  createWorkspaceStore,
  focusPane,
  loadVault,
  workspaceNow,
} from '../workspace/workspace-store.ts';
import {
  clearRow,
  createAsideStore,
  focusRow,
  hideAside,
  selectAsideTab,
  setAsideFolded,
  showAsideTab,
} from './aside-store.ts';
import { usePropertiesInAside } from './use-properties-in-aside.ts';

const NOTE = createVaultPath('Tasks/Ship it.md');
const ROW = createVaultPath('Tasks/Plan.md');

/** A split window, the same note in both panes, pane 0 focused. */
function windowOn() {
  const one = openInActiveTab(EMPTY_WORKSPACE, { kind: 'note', path: NOTE });
  const workspace = createWorkspaceStore({
    remembered: { read: () => splitWithTab(one), write: () => {} },
  });
  loadVault(workspace, '/v');
  focusPane(workspace, 0);
  const aside = createAsideStore({ remembered: { read: () => null, write: () => {} } });
  const tabs = workspaceNow(workspace).panes.map((pane) => pane.active);
  return { workspace, aside, tabs };
}

describe('usePropertiesInAside', () => {
  it('is true only for the focused pane’s shown tab while the aside shows Properties', () => {
    const { workspace, aside, tabs } = windowOn();
    const inPane0 = renderHook(() =>
      usePropertiesInAside({ aside, workspace, tab: tabs[0]!, path: NOTE }),
    );
    const inPane1 = renderHook(() =>
      usePropertiesInAside({ aside, workspace, tab: tabs[1]!, path: NOTE }),
    );
    expect(inPane0.result.current).toBe(false);

    act(() => showAsideTab(aside, 'properties'));
    expect(inPane0.result.current).toBe(true);
    expect(inPane1.result.current).toBe(false);

    act(() => focusPane(workspace, 1));
    expect(inPane0.result.current).toBe(false);
    expect(inPane1.result.current).toBe(true);

    act(() => selectAsideTab(aside, 'outline'));
    expect(inPane1.result.current).toBe(false);
    act(() => selectAsideTab(aside, 'properties'));
    act(() => setAsideFolded(aside, true));
    expect(inPane1.result.current).toBe(false);
    act(() => setAsideFolded(aside, false));
    act(() => hideAside(aside));
    expect(inPane1.result.current).toBe(false);
  });

  it('is false while a row of this tab’s table has the aside', () => {
    const { workspace, aside, tabs } = windowOn();
    showAsideTab(aside, 'properties');
    const { result } = renderHook(() =>
      usePropertiesInAside({ aside, workspace, tab: tabs[0]!, path: NOTE }),
    );
    expect(result.current).toBe(true);
    act(() => focusRow(aside, { tab: tabs[0]!, path: ROW, within: NOTE }));
    expect(result.current).toBe(false);
    act(() => clearRow(aside, tabs[0]!));
    expect(result.current).toBe(true);
  });

  it('draws the tab for its own answer only: not for a pane focus while the aside is shut', () => {
    const { workspace, aside, tabs } = windowOn();
    const draws = vi.fn();
    renderHook(() => {
      draws();
      return usePropertiesInAside({ aside, workspace, tab: tabs[0]!, path: NOTE });
    });
    act(() => focusPane(workspace, 1));
    act(() => focusPane(workspace, 0));
    act(() => focusRow(aside, { tab: tabs[0]!, path: ROW, within: NOTE }));
    expect(draws).toHaveBeenCalledTimes(1);
    expect(activeTabOf(workspaceNow(workspace)).id).toBe(tabs[0]);
  });
});
