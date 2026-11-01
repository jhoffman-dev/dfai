// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  createVaultPath,
  EMPTY_WORKSPACE,
  openInActiveTab,
  type NavigationPlace,
} from '@dfai/domain';
import { ASIDE_WIDTH, ASIDE_WIDTH_TYPE } from '@dfai/ui';
import { createWorkspaceStore, loadVault, openPlace } from '../workspace/workspace-store.ts';
import { createAsideStore, selectAsideTab } from './aside-store.ts';
import { useAsideWidth } from './use-aside-width.ts';

const VIEW = createVaultPath('.atlas/views/Meeting table.md');
const VIEWS = [{ path: VIEW, type: 'meeting' }];
const TYPES = [{ name: 'meeting' }];

function on(place: NavigationPlace) {
  const workspace = createWorkspaceStore({
    remembered: { read: () => openInActiveTab(EMPTY_WORKSPACE, place), write: () => {} },
  });
  loadVault(workspace, '/v');
  const aside = createAsideStore({ remembered: { read: () => null, write: () => {} } });
  const hook = renderHook(() =>
    useAsideWidth({ aside, workspace, savedViews: VIEWS, types: TYPES }),
  );
  return { workspace, aside, hook };
}

describe('useAsideWidth', () => {
  it('is 300 on any tab but Type', () => {
    const { hook } = on({ kind: 'type', name: 'meeting' });
    expect(hook.result.current).toBe(ASIDE_WIDTH);
  });

  it('is 340 on the Type tab where a type or its view is shown, and 300 again elsewhere', () => {
    const { aside, workspace, hook } = on({ kind: 'note', path: VIEW });
    act(() => selectAsideTab(aside, 'type'));
    expect(hook.result.current).toBe(ASIDE_WIDTH_TYPE);
    // A page with no type offers no Type tab: the aside falls back, at 300.
    act(() => openPlace(workspace, { kind: 'today' }, 'here'));
    expect(hook.result.current).toBe(ASIDE_WIDTH);
  });

  it('is 300 for a type the vault does not define', () => {
    const { aside, hook } = on({ kind: 'type', name: 'gone' });
    act(() => selectAsideTab(aside, 'type'));
    expect(hook.result.current).toBe(ASIDE_WIDTH);
  });
});
