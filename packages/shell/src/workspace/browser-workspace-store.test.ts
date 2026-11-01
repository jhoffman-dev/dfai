// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVaultPath, EMPTY_WORKSPACE, openInActiveTab, openInNewTab } from '@dfai/domain';
import { browserWorkspaceStore } from './browser-workspace-store.ts';

const note = (name: string) => ({ kind: 'note' as const, path: createVaultPath(`${name}.md`) });

describe('browserWorkspaceStore', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips a vault’s tabs under its own key, and reads nothing for another vault', () => {
    const workspace = openInNewTab(openInActiveTab(EMPTY_WORKSPACE, note('a')), note('b'));
    browserWorkspaceStore.write({ vaultKey: '/v', workspace });

    expect(window.localStorage.getItem('atlas.workspace:/v')).not.toBeNull();
    expect(browserWorkspaceStore.read('/v')).toEqual({ ...workspace, closed: [] });
    expect(browserWorkspaceStore.read('/other')).toBeNull();
  });

  it('reads the split kept before there were tabs, as one tab per pane', () => {
    window.localStorage.setItem(
      'atlas.panes',
      JSON.stringify({ vault: '/v', paths: ['a.md', 'b.md'], focused: 1 }),
    );
    const read = browserWorkspaceStore.read('/v');
    expect(read?.panes.map((pane) => pane.tabs.map((tab) => tab.history.current))).toEqual([
      [note('a')],
      [note('b')],
    ]);
    expect(read?.focused).toBe(1);
    // Once tabs are written, they win over the old split.
    browserWorkspaceStore.write({ vaultKey: '/v', workspace: EMPTY_WORKSPACE });
    expect(browserWorkspaceStore.read('/v')).toEqual(EMPTY_WORKSPACE);
  });

  it('reads nothing for storage that is malformed, and keeps going when storage is blocked', () => {
    window.localStorage.setItem('atlas.workspace:/v', '{not json');
    expect(browserWorkspaceStore.read('/v')).toBeNull();

    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(() =>
      browserWorkspaceStore.write({ vaultKey: '/v', workspace: EMPTY_WORKSPACE }),
    ).not.toThrow();
    blocked.mockRestore();
  });
});
