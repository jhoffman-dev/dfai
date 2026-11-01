import { createStore, useStore, type StoreApi } from 'zustand';
import {
  activateNth,
  activateTab as activateTabIn,
  activeTabOf,
  askShortcut,
  closePaneInWorkspace,
  closeTab as closeTabIn,
  EMPTY_WORKSPACE,
  focusPaneInWorkspace,
  followMoveInWorkspace,
  forgetNotesInWorkspace,
  goBackInTab,
  goForwardInTab,
  isVisibleEntry,
  isWorkspaceSplit,
  MAX_PANES,
  newTab as addEmptyTab,
  nextTab as nextTabIn,
  openInActiveTab,
  openInActiveTabOf,
  openInNewTab,
  openInSplit,
  previousTab as previousTabIn,
  reopenClosedTab as reopenClosedTabIn,
  splitWithTab,
  tabPlace,
  type EntryMove,
  type NavigationHistory,
  type NavigationPlace,
  type PagePlace,
  type Pane,
  type Tab,
  type TabId,
  type VaultPath,
  type Workspace,
} from '@dfai/domain';
import type { OpenHow } from '@dfai/ui';

/**
 * Where a viewer's tabs are remembered, per vault.
 *
 * Per viewer, so not in the vault: how the window is arranged says nothing
 * about the notes, and two people opening the same vault do not owe each
 * other a layout. It is still I/O, so this is a port and the composition
 * root hands over the browser one.
 */
export interface RememberedWorkspaces {
  /** `null` when the vault has no remembered layout, which is not an error. */
  read: (vaultKey: string) => Workspace | null;
  write: (args: { vaultKey: string; workspace: Workspace }) => void;
}

export interface WorkspaceState {
  /** The vault the tabs belong to; null before one is open. */
  readonly vault: string | null;
  readonly workspace: Workspace;
  /**
   * One key per pane, in the panes' order, that stays with the pane while it
   * is open. A pane's place changes when the one before it closes; React keys
   * the panes by these so the pane that is left keeps its editors and typing.
   */
  readonly paneKeys: readonly number[];
  /** The next new pane's key. Never handed out twice. */
  readonly nextPaneKey: number;
  /**
   * The notes the restored workspace's tabs were on, until the vault's
   * listing has judged them: a tab opened since is never that listing's to
   * close, and a listing can judge only once.
   */
  readonly restoredNotes: ReadonlySet<string>;
  /** Where the tabs are remembered, held here so every change can write itself. */
  readonly remembered: RememberedWorkspaces;
}

/**
 * The window's tabs and panes, held outside `App` (ADR-0040, tab-model.md §3):
 * what draws a strip or a pane's page subscribes to its slice, so a tab
 * switch draws the strip and one pane's content and nothing else. The rules
 * are the domain's (`workspace.ts`); this holds the current workspace, reads
 * the remembered one when a vault opens, and writes every change back.
 */
export type WorkspaceStore = StoreApi<WorkspaceState>;

export function createWorkspaceStore({
  remembered,
}: {
  remembered: RememberedWorkspaces;
}): WorkspaceStore {
  return createStore<WorkspaceState>()(() => ({
    vault: null,
    workspace: EMPTY_WORKSPACE,
    paneKeys: freshKeys(EMPTY_WORKSPACE),
    nextPaneKey: MAX_PANES,
    restoredNotes: new Set(),
    remembered,
  }));
}

/** A key for each pane of a layout just read; a pane added later is keyed from `MAX_PANES` up. */
const freshKeys = (workspace: Workspace): number[] => workspace.panes.map((_, pane) => pane);

// ---- Reading --------------------------------------------------------------

/** The workspace as it stands, read at the moment it is needed rather than subscribed to. */
export function workspaceNow(store: WorkspaceStore): Workspace {
  return store.getState().workspace;
}

export function usePaneKeys(store: WorkspaceStore): readonly number[] {
  return useStore(store, (state) => state.paneKeys);
}

export function useFocusedPane(store: WorkspaceStore): number {
  return useStore(store, (state) => state.workspace.focused);
}

/** Reference-stable: the pane's own tabs array, which changes only when its tabs do. */
export function usePaneTabs(store: WorkspaceStore, pane: number): readonly Tab[] {
  return useStore(store, (state) => paneAt(state.workspace, pane).tabs);
}

export function useActiveTabId(store: WorkspaceStore, pane: number): TabId {
  return useStore(store, (state) => paneAt(state.workspace, pane).active);
}

/** Reference-stable: the place object the tab's history holds. */
export function useActivePlace(store: WorkspaceStore, pane: number): NavigationPlace | null {
  return useStore(store, (state) => activePlaceOf(paneAt(state.workspace, pane)));
}

export function useTabHistory(
  store: WorkspaceStore,
  { pane, id }: { pane: number; id: TabId },
): NavigationHistory {
  return useStore(store, (state) => historyOf(state.workspace, { pane, id }));
}

/** What the focused pane shows: what the sidebar marks as where you are. */
export function useFocusedPlace(store: WorkspaceStore): NavigationPlace | null {
  return useStore(store, (state) => activePlace(state.workspace));
}

/**
 * Whether a pane's shown tab is on a page of `kind`, in any pane. A page is
 * a tab and draws itself (tab-model.md, PR B); the app reads this for the
 * few things it keeps alive only while a page shows — the Activity badge,
 * the automations' live listing, the Inbox's offers — and is drawn only as
 * that flips, not for a switch between notes or between other pages.
 */
export function usePageShown(store: WorkspaceStore, kind: PagePlace['kind']): boolean {
  return useStore(store, (state) => isPageShown(state.workspace, kind));
}

function isPageShown(workspace: Workspace, kind: PagePlace['kind']): boolean {
  return workspace.panes.some((pane) => activePlaceOf(pane)?.kind === kind);
}

function paneAt(workspace: Workspace, pane: number): Pane {
  // A pane that has just closed is read once more by the render on its way
  // out; an empty pane is what it reads, not an error.
  return workspace.panes[pane] ?? (EMPTY_WORKSPACE.panes[0] as Pane);
}

function activePlaceOf(pane: Pane): NavigationPlace | null {
  const tab = pane.tabs.find((held) => held.id === pane.active);
  return tab === undefined ? null : tabPlace(tab);
}

/** What the focused pane's shown tab is on, read outside a render or in a selector. */
export function activePlace(workspace: Workspace): NavigationPlace | null {
  return tabPlace(activeTabOf(workspace));
}

/** The note the focused pane's shown tab is on, or null while it is on a page or nothing. */
export function focusedNotePath(workspace: Workspace): VaultPath | null {
  const place = activePlace(workspace);
  return place?.kind === 'note' ? place.path : null;
}

const NO_HISTORY_YET: NavigationHistory = { back: [], current: null, forward: [] };

function historyOf(workspace: Workspace, { pane, id }: { pane: number; id: TabId }) {
  return paneAt(workspace, pane).tabs.find((tab) => tab.id === id)?.history ?? NO_HISTORY_YET;
}

// ---- Changing --------------------------------------------------------------

/**
 * Reads the vault's remembered tabs, in the same event as the location
 * change and not in an effect after it: an effect leaves one render with the
 * old vault's paths under the new vault's key, and R14-01 found a race
 * living in exactly that render. Opening the vault already open changes nothing.
 */
export function loadVault(store: WorkspaceStore, vaultKey: string | null): void {
  const state = store.getState();
  if (state.vault === vaultKey) return;
  const workspace =
    vaultKey === null ? EMPTY_WORKSPACE : (state.remembered.read(vaultKey) ?? EMPTY_WORKSPACE);
  store.setState({
    vault: vaultKey,
    workspace,
    paneKeys: freshKeys(workspace),
    nextPaneKey: MAX_PANES,
    restoredNotes: notesOf(workspace),
  });
}

/** Every note a workspace's tabs are on, or hold in their Back and Forward. */
function notesOf(workspace: Workspace): ReadonlySet<string> {
  const notes = new Set<string>();
  for (const pane of workspace.panes) {
    for (const tab of pane.tabs) {
      const { back, current, forward } = tab.history;
      for (const place of [...back, current, ...forward]) {
        if (place?.kind === 'note') notes.add(place.path);
      }
    }
  }
  return notes;
}

/** Applies a domain change, keys the panes after it, and writes the result. */
function change(store: WorkspaceStore, step: (workspace: Workspace) => Workspace): void {
  const state = store.getState();
  const next = step(state.workspace);
  if (next === state.workspace) return;
  const { paneKeys, nextPaneKey } = keyedAfter(state, next);
  // Outside the state update on purpose: a write belongs to this one event.
  if (state.vault !== null) state.remembered.write({ vaultKey: state.vault, workspace: next });
  store.setState({ workspace: next, paneKeys, nextPaneKey });
}

/**
 * Each pane of `next` keeps the key of the pane of `was` that held its tabs:
 * ids are never reused, so one shared id is proof of the same pane. A pane
 * with no tab from before — a new split, or the fresh tab left by closing the
 * last — gets the next key, and nothing of the old pane is kept for it.
 */
function keyedAfter(
  { workspace: was, paneKeys, nextPaneKey }: WorkspaceState,
  next: Workspace,
): Pick<WorkspaceState, 'paneKeys' | 'nextPaneKey'> {
  if (next.panes === was.panes) return { paneKeys, nextPaneKey };
  let minted = nextPaneKey;
  const keys = next.panes.map((pane) => {
    const ids = new Set(pane.tabs.map((tab) => tab.id));
    const before = was.panes.findIndex((held) => held.tabs.some((tab) => ids.has(tab.id)));
    if (before !== -1) return paneKeys[before] as number;
    minted += 1;
    return minted - 1;
  });
  const unchanged =
    keys.length === paneKeys.length && keys.every((key, at) => key === paneKeys[at]);
  // The same array when no pane came or went, so a tab switch does not draw the panes.
  return { paneKeys: unchanged ? paneKeys : keys, nextPaneKey: minted };
}

/** Opens a place where a click asked for it: here, in a new tab, or in a split. */
export function openPlace(store: WorkspaceStore, place: NavigationPlace, how: OpenHow): void {
  change(store, (ws) => {
    if (how === 'new-tab') return openInNewTab(ws, place);
    if (how === 'split') return openInSplit(ws, place);
    return openInActiveTab(ws, place);
  });
}

/** Opens in one named pane's active tab, which takes the focus: a link followed inside it. */
export function openInPane(
  store: WorkspaceStore,
  { pane, place }: { pane: number; place: NavigationPlace },
): void {
  change(store, (ws) => openInActiveTabOf(ws, { pane, place }));
}

export function activateTab(store: WorkspaceStore, at: { pane: number; id: TabId }): void {
  change(store, (ws) => activateTabIn(ws, at));
}

export function closeTab(store: WorkspaceStore, at: { pane: number; id: TabId }): void {
  change(store, (ws) => closeTabIn(ws, at));
}

/** Closes the focused pane's shown tab: ⌘W. Never the window. */
export function closeActiveTab(store: WorkspaceStore): void {
  change(store, (ws) => closeTabIn(ws, { pane: ws.focused, id: activeTabOf(ws).id }));
}

/** Adds an empty tab at the end of a pane and shows it, the pane taking the focus: its +. */
export function newTabIn(store: WorkspaceStore, pane: number): void {
  change(store, (ws) => addEmptyTab(focusPaneInWorkspace(ws, pane)));
}

export function nextTab(store: WorkspaceStore): void {
  change(store, nextTabIn);
}

export function previousTab(store: WorkspaceStore): void {
  change(store, previousTabIn);
}

export function activateNthTab(store: WorkspaceStore, n: number): void {
  change(store, (ws) => activateNth(ws, n));
}

export function reopenClosedTab(store: WorkspaceStore): void {
  change(store, reopenClosedTabIn);
}

/**
 * Splits, the new pane starting on a copy of a pane's shown tab: the named
 * pane's, which takes the focus as its bar's button is pressed, else the
 * focused pane's.
 */
export function splitPane(store: WorkspaceStore, pane?: number): void {
  change(store, (ws) => splitWithTab(pane === undefined ? ws : focusPaneInWorkspace(ws, pane)));
}

export function closePane(store: WorkspaceStore, pane: number): void {
  change(store, (ws) => closePaneInWorkspace(ws, pane));
}

/** Splits, or closes the focused pane once the window is split: ⇧⌘\. */
export function toggleSplit(store: WorkspaceStore): void {
  change(store, (ws) =>
    isWorkspaceSplit(ws) ? closePaneInWorkspace(ws, ws.focused) : splitWithTab(ws),
  );
}

export function focusPane(store: WorkspaceStore, pane: number): void {
  change(store, (ws) => focusPaneInWorkspace(ws, pane));
}

/**
 * ⌘J (#37): Ask, or back from it to where you were. True when Ask is what
 * the focused pane shows after it, where the question box takes the keys.
 */
export function toggleAsk(store: WorkspaceStore): boolean {
  change(store, askShortcut);
  return activePlace(workspaceNow(store))?.kind === 'ask';
}

/** Back in the focused pane's shown tab: ⌘[ and the mouse's back button. */
export function goBack(store: WorkspaceStore): void {
  change(store, goBackInTab);
}

export function goForward(store: WorkspaceStore): void {
  change(store, goForwardInTab);
}

/** Back in a named pane's shown tab, which takes the focus: its bar's own arrow. */
export function goBackIn(store: WorkspaceStore, pane: number): void {
  change(store, (ws) => goBackInTab(focusPaneInWorkspace(ws, pane)));
}

export function goForwardIn(store: WorkspaceStore, pane: number): void {
  change(store, (ws) => goForwardInTab(focusPaneInWorkspace(ws, pane)));
}

/** Follows a move or a rename: every tab on a moved note holds it where it went. */
export function followMove(store: WorkspaceStore, move: EntryMove): void {
  change(store, (ws) => followMoveInWorkspace(ws, move));
}

/** Forgets notes that are gone from every tab's page and history. */
export function closeNotes(store: WorkspaceStore, paths: readonly VaultPath[]): void {
  const gone = new Set<string>(paths);
  change(store, (ws) => forgetNotesInWorkspace(ws, (path) => gone.has(path)));
}

/**
 * Forgets every restored note the vault's listing does not have: the notes
 * in user space as listed once the vault opens, against the tabs remembered
 * from the last launch. A tab on a note deleted while the app was closed
 * opens on nothing rather than on a read error, under the same rules a
 * delete in the app follows. Only the notes the restore brought back are
 * judged, and only once: a note opened since — made or renamed while the
 * listing was on its way — is not the listing's to close, and a later
 * listing, from a reload or from the vault before, closes nothing. A note
 * the listing never covers — a view, a dashboard, a template under `.atlas`
 * — is not judged either.
 */
export function keepNotes(store: WorkspaceStore, listed: readonly VaultPath[]): void {
  const { restoredNotes } = store.getState();
  if (restoredNotes.size === 0) return;
  const kept = new Set<string>(listed);
  const covered = (path: VaultPath) =>
    isVisibleEntry({ kind: 'file', name: path.split('/').at(-1) ?? path, path });
  store.setState({ restoredNotes: new Set() });
  change(store, (ws) =>
    forgetNotesInWorkspace(
      ws,
      (path) => restoredNotes.has(path) && covered(path) && !kept.has(path),
    ),
  );
}
