// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  createVaultPath,
  EMPTY_WORKSPACE,
  MAX_PANES,
  type NavigationPlace,
  type Workspace,
} from '@dfai/domain';
import {
  activateNthTab,
  activateTab,
  closeNotes,
  closePane,
  closeTab,
  createWorkspaceStore,
  focusPane,
  followMove,
  goBack,
  goBackIn,
  goForward,
  keepNotes,
  loadVault,
  newTabIn,
  nextTab,
  openInPane,
  openPlace,
  previousTab,
  reopenClosedTab,
  splitPane,
  toggleSplit,
  useActivePlace,
  useActiveTabId,
  useFocusedPane,
  useFocusedPlace,
  usePaneKeys,
  usePaneTabs,
  usePageShown,
  useTabHistory,
  workspaceNow,
  type RememberedWorkspaces,
} from './workspace-store.ts';

const note = (name: string): NavigationPlace => ({
  kind: 'note',
  path: createVaultPath(`${name}.md`),
});
const TODAY: NavigationPlace = { kind: 'today' };
const INBOX: NavigationPlace = { kind: 'inbox' };

/** Remembered layouts held in memory, and every write made. */
function memoryRemembered(held: Record<string, Workspace> = {}) {
  const writes: { vaultKey: string; workspace: Workspace }[] = [];
  const port: RememberedWorkspaces = {
    read: (vaultKey) => held[vaultKey] ?? null,
    write: (written) => {
      writes.push(written);
      held[written.vaultKey] = written.workspace;
    },
  };
  return { port, writes, held };
}

function openOn(vaultKey = '/v', held?: Record<string, Workspace>) {
  const remembered = memoryRemembered(held);
  const store = createWorkspaceStore({ remembered: remembered.port });
  loadVault(store, vaultKey);
  return { store, ...remembered };
}

const placesOf = (ws: Workspace, pane = 0) =>
  ws.panes[pane]?.tabs.map((tab) => tab.history.current) ?? [];

describe('the workspace store', () => {
  it('starts on one empty tab with no vault, and reads the vault’s layout when one opens', () => {
    const remembered = memoryRemembered();
    const store = createWorkspaceStore({ remembered: remembered.port });
    expect(workspaceNow(store)).toBe(EMPTY_WORKSPACE);
    expect(store.getState().vault).toBeNull();

    openPlace(store, note('a'), 'here');
    expect(remembered.writes).toEqual([]);

    const kept: Workspace = {
      ...EMPTY_WORKSPACE,
      panes: [
        {
          tabs: [
            { id: 't1', pinned: false, history: { back: [], current: note('k'), forward: [] } },
          ],
          active: 't1',
        },
      ],
    };
    remembered.held['/v'] = kept;
    loadVault(store, '/v');
    expect(workspaceNow(store)).toBe(kept);
    expect(store.getState().paneKeys).toEqual([0]);

    // Another vault's tabs are not carried over: a path means nothing in it.
    loadVault(store, '/other');
    expect(workspaceNow(store)).toBe(EMPTY_WORKSPACE);
    loadVault(store, null);
    expect(workspaceNow(store)).toBe(EMPTY_WORKSPACE);
  });

  it('loads a vault once: opening the same vault again keeps the tabs as they are', () => {
    const { store } = openOn();
    openPlace(store, note('a'), 'here');
    const before = workspaceNow(store);
    loadVault(store, '/v');
    expect(workspaceNow(store)).toBe(before);
  });

  it('opens here, in a new tab beside the active one, or in a split, and writes each change', () => {
    const { store, writes } = openOn();
    openPlace(store, note('a'), 'here');
    openPlace(store, note('b'), 'here');
    expect(placesOf(workspaceNow(store))).toEqual([note('b')]);

    openPlace(store, note('c'), 'new-tab');
    expect(placesOf(workspaceNow(store))).toEqual([note('b'), note('c')]);
    expect(workspaceNow(store).panes[0]?.active).toBe('t2');

    openPlace(store, note('d'), 'split');
    expect(workspaceNow(store).panes).toHaveLength(2);
    expect(workspaceNow(store).focused).toBe(1);
    expect(placesOf(workspaceNow(store), 1)).toEqual([note('d')]);
    expect(writes).toHaveLength(4);
    expect(writes.at(-1)?.vaultKey).toBe('/v');
  });

  it('activates the tab already on a place rather than opening it twice, and writes nothing for a no-op', () => {
    const { store, writes } = openOn();
    openPlace(store, note('a'), 'here');
    openPlace(store, note('b'), 'new-tab');
    const written = writes.length;
    openPlace(store, note('a'), 'here');
    expect(workspaceNow(store).panes[0]?.active).toBe('t1');
    expect(writes).toHaveLength(written + 1);
    const before = workspaceNow(store);
    openPlace(store, note('a'), 'here');
    expect(workspaceNow(store)).toBe(before);
    expect(writes).toHaveLength(written + 1);
  });

  it('keeps a pane’s key as the pane before it closes, so React keeps its editor', () => {
    const { store } = openOn();
    openPlace(store, note('a'), 'here');
    splitPane(store);
    expect(store.getState().paneKeys).toEqual([0, MAX_PANES]);
    openPlace(store, note('b'), 'here');
    closePane(store, 0);
    expect(store.getState().paneKeys).toEqual([MAX_PANES]);
    expect(placesOf(workspaceNow(store))).toEqual([note('b')]);
    // A new pane never shares a key with one that closed.
    splitPane(store);
    expect(store.getState().paneKeys).toEqual([MAX_PANES, MAX_PANES + 1]);
  });

  it('gives a freshly emptied pane a new key: nothing of the old one is worth keeping', () => {
    const { store } = openOn();
    openPlace(store, note('a'), 'here');
    closeTab(store, { pane: 0, id: 't1' });
    expect(store.getState().paneKeys).toEqual([MAX_PANES]);
    expect(placesOf(workspaceNow(store))).toEqual([null]);
  });

  it('closes tabs, walks and numbers them, and reopens the last closed one', () => {
    const { store } = openOn();
    openPlace(store, note('a'), 'here');
    openPlace(store, note('b'), 'new-tab');
    openPlace(store, note('c'), 'new-tab');
    activateNthTab(store, 1);
    expect(activeIdOf(store)).toBe('t1');
    nextTab(store);
    expect(activeIdOf(store)).toBe('t2');
    previousTab(store);
    previousTab(store);
    expect(activeIdOf(store)).toBe('t3');
    closeTab(store, { pane: 0, id: 't3' });
    expect(placesOf(workspaceNow(store))).toEqual([note('a'), note('b')]);
    reopenClosedTab(store);
    expect(placesOf(workspaceNow(store))).toEqual([note('a'), note('b'), note('c')]);
    newTabIn(store, 0);
    expect(placesOf(workspaceNow(store))).toEqual([note('a'), note('b'), note('c'), null]);
  });

  it('adds a tab to the pane whose + was pressed, which takes the focus', () => {
    const { store } = openOn();
    openPlace(store, note('a'), 'here');
    splitPane(store);
    focusPane(store, 1);
    newTabIn(store, 0);
    expect(workspaceNow(store).focused).toBe(0);
    expect(workspaceNow(store).panes[0]?.tabs).toHaveLength(2);
    expect(workspaceNow(store).panes[1]?.tabs).toHaveLength(1);
  });

  it('goes back and forward in the focused tab, or in a named pane, which takes the focus', () => {
    const { store } = openOn();
    openPlace(store, note('a'), 'here');
    openPlace(store, note('b'), 'here');
    goBack(store);
    expect(placesOf(workspaceNow(store))).toEqual([note('a')]);
    goForward(store);
    expect(placesOf(workspaceNow(store))).toEqual([note('b')]);

    splitPane(store);
    openPlace(store, note('c'), 'here');
    focusPane(store, 0);
    goBackIn(store, 1);
    expect(workspaceNow(store).focused).toBe(1);
    expect(placesOf(workspaceNow(store), 1)).toEqual([note('b')]);
  });

  it('splits, toggles the split, and opens into a named pane', () => {
    const { store } = openOn();
    openPlace(store, note('a'), 'here');
    toggleSplit(store);
    expect(workspaceNow(store).panes).toHaveLength(2);
    openInPane(store, { pane: 0, place: note('b') });
    expect(workspaceNow(store).focused).toBe(0);
    expect(placesOf(workspaceNow(store), 0)).toEqual([note('b')]);
    toggleSplit(store);
    expect(workspaceNow(store).panes).toHaveLength(1);
    expect(placesOf(workspaceNow(store), 0)).toEqual([note('a')]);
  });

  it('follows a move and forgets deleted notes in every tab', () => {
    const { store } = openOn();
    openPlace(store, note('a'), 'here');
    openPlace(store, note('b'), 'new-tab');
    followMove(store, { from: createVaultPath('a.md'), to: createVaultPath('z.md') });
    expect(placesOf(workspaceNow(store))).toEqual([note('z'), note('b')]);
    closeNotes(store, [createVaultPath('b.md')]);
    expect(placesOf(workspaceNow(store))).toEqual([note('z')]);
  });

  it('keeps only the notes the vault lists: a remembered tab on a deleted note empties', () => {
    const board = createVaultPath('.atlas/views/Board.md');
    const remembered = memoryRemembered({
      '/v': {
        ...EMPTY_WORKSPACE,
        nextId: 4,
        panes: [
          {
            active: 't2',
            tabs: [
              { id: 't1', pinned: false, history: { back: [], current: note('a'), forward: [] } },
              {
                id: 't2',
                pinned: false,
                history: { back: [note('a')], current: note('gone'), forward: [] },
              },
              // A view: the listing of user-space notes never has it, and it stays.
              {
                id: 't3',
                pinned: false,
                history: { back: [], current: { kind: 'note', path: board }, forward: [] },
              },
            ],
          },
        ],
      },
    });
    const store = createWorkspaceStore({ remembered: remembered.port });
    loadVault(store, '/v');
    keepNotes(store, [createVaultPath('a.md'), createVaultPath('b.md')]);
    expect(placesOf(workspaceNow(store))).toEqual([note('a'), null, { kind: 'note', path: board }]);
    // Its Back still leads to a note that is there.
    expect(workspaceNow(store).panes[0]?.tabs[1]?.history.back).toEqual([note('a')]);
    // The same list again changes nothing, and writes nothing.
    const written = remembered.writes.length;
    keepNotes(store, [createVaultPath('a.md'), createVaultPath('b.md')]);
    expect(remembered.writes).toHaveLength(written);
  });

  it('judges only the notes the restore brought back, and only once', () => {
    const remembered = memoryRemembered({
      '/v': {
        ...EMPTY_WORKSPACE,
        panes: [
          {
            active: 't1',
            tabs: [
              {
                id: 't1',
                pinned: false,
                history: { back: [], current: note('gone'), forward: [] },
              },
            ],
          },
        ],
      },
    });
    const store = createWorkspaceStore({ remembered: remembered.port });
    loadVault(store, '/v');
    // Made while the listing was on its way: the listing started before it existed.
    openPlace(store, note('made-since'), 'new-tab');
    keepNotes(store, [createVaultPath('a.md')]);
    // The restored tab, left with nothing beside another tab, closes; the new one stays.
    expect(placesOf(workspaceNow(store))).toEqual([note('made-since')]);

    // A later listing — a reload's, or one from the vault before — judges nothing.
    openPlace(store, note('renamed-since'), 'new-tab');
    keepNotes(store, []);
    expect(placesOf(workspaceNow(store))).toEqual([note('made-since'), note('renamed-since')]);
  });

  describe('what each selector draws for', () => {
    it('draws the strip and one pane’s content for a tab switch, and nothing else', () => {
      const { store } = openOn();
      openPlace(store, note('a'), 'here');
      splitPane(store);
      focusPane(store, 0);
      openPlace(store, note('b'), 'new-tab');
      const drawn = { keys: 0, focused: 0, tabs0: 0, active0: 0, place0: 0, place1: 0, tabs1: 0 };
      renderHook(() => {
        drawn.keys += 1;
        return usePaneKeys(store);
      });
      renderHook(() => {
        drawn.focused += 1;
        return useFocusedPane(store);
      });
      renderHook(() => {
        drawn.tabs0 += 1;
        return usePaneTabs(store, 0);
      });
      renderHook(() => {
        drawn.active0 += 1;
        return useActiveTabId(store, 0);
      });
      const place0 = renderHook(() => {
        drawn.place0 += 1;
        return useActivePlace(store, 0);
      });
      renderHook(() => {
        drawn.place1 += 1;
        return useActivePlace(store, 1);
      });
      renderHook(() => {
        drawn.tabs1 += 1;
        return usePaneTabs(store, 1);
      });
      const before = { ...drawn };

      act(() => activateTab(store, { pane: 0, id: 't1' }));

      expect(place0.result.current).toEqual(note('a'));
      expect(drawn.active0 - before.active0).toBe(1);
      expect(drawn.place0 - before.place0).toBe(1);
      expect(drawn.keys - before.keys).toBe(0);
      expect(drawn.focused - before.focused).toBe(0);
      expect(drawn.tabs0 - before.tabs0).toBe(0);
      expect(drawn.tabs1 - before.tabs1).toBe(0);
      expect(drawn.place1 - before.place1).toBe(0);
    });

    it('draws the focused pane alone for a focus change', () => {
      const { store } = openOn();
      openPlace(store, note('a'), 'here');
      splitPane(store);
      const drawn = { focused: 0, place0: 0, place1: 0 };
      const focused = renderHook(() => {
        drawn.focused += 1;
        return useFocusedPane(store);
      });
      renderHook(() => {
        drawn.place0 += 1;
        return useActivePlace(store, 0);
      });
      renderHook(() => {
        drawn.place1 += 1;
        return useActivePlace(store, 1);
      });
      const before = { ...drawn };
      act(() => focusPane(store, 0));
      expect(focused.result.current).toBe(0);
      expect(drawn.focused - before.focused).toBe(1);
      expect(drawn.place0 - before.place0).toBe(0);
      expect(drawn.place1 - before.place1).toBe(0);
    });

    it('hands the sidebar the focused pane’s place, and a tab its own history', () => {
      const { store } = openOn();
      openPlace(store, note('a'), 'here');
      openPlace(store, note('b'), 'here');
      const place = renderHook(() => useFocusedPlace(store));
      const history = renderHook(() => useTabHistory(store, { pane: 0, id: 't1' }));
      expect(place.result.current).toEqual(note('b'));
      expect(history.result.current).toEqual({
        back: [note('a')],
        current: note('b'),
        forward: [],
      });
      act(() => goBack(store));
      expect(place.result.current).toEqual(note('a'));
      expect(history.result.current.forward).toEqual([note('b')]);
    });

    it('tells the app whether a page of a kind is shown in any pane, drawing it only as that flips', () => {
      const { store } = openOn();
      openPlace(store, note('a'), 'here');
      let drawn = 0;
      const todayShown = renderHook(() => {
        drawn += 1;
        return usePageShown(store, 'today');
      });
      expect(todayShown.result.current).toBe(false);
      const before = drawn;

      act(() => openPlace(store, note('b'), 'here'));
      act(() => openPlace(store, note('c'), 'new-tab'));
      act(() => openPlace(store, INBOX, 'here'));
      expect(todayShown.result.current).toBe(false);
      expect(drawn - before).toBe(0);

      act(() => openPlace(store, TODAY, 'here'));
      expect(todayShown.result.current).toBe(true);
      expect(drawn - before).toBe(1);

      // Shown in the other pane counts too, whichever pane is focused.
      act(() => openPlace(store, INBOX, 'split'));
      expect(todayShown.result.current).toBe(true);
      act(() => focusPane(store, 0));
      expect(drawn - before).toBe(1);
      act(() => openPlace(store, note('a'), 'here'));
      expect(todayShown.result.current).toBe(false);
      expect(drawn - before).toBe(2);
    });
  });
});

function activeIdOf(store: ReturnType<typeof createWorkspaceStore>): string | undefined {
  const ws = workspaceNow(store);
  return ws.panes[ws.focused]?.active;
}
