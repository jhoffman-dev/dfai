import { describe, expect, it, vi } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import { createRevealStore } from '../panes/reveals.ts';
import { createOverlayStore, openPeek, peekNow, showOverlay } from '../overlay-store.ts';
import { clickLink, followLink, openDocumentAt, openNote } from './open-place.ts';
import { createWorkspaceStore, loadVault, splitPane, workspaceNow } from './workspace-store.ts';

const PLAN = createVaultPath('Plan.md');
const OTHER = createVaultPath('Other.md');

function following() {
  const store = createWorkspaceStore({ remembered: { read: () => null, write: () => {} } });
  loadVault(store, '/v');
  const onProblem = vi.fn();
  const reveals = createRevealStore();
  return { store, reveals, notePaths: [PLAN, OTHER], onProblem };
}

const placesOf = (store: ReturnType<typeof following>['store'], pane = 0) =>
  workspaceNow(store).panes[pane]?.tabs.map((tab) => tab.history.current) ?? [];

describe('openNote', () => {
  it('opens here unless the click asked for a new tab or a split', () => {
    const { store } = following();
    openNote(store, PLAN);
    openNote(store, OTHER, 'new-tab');
    expect(placesOf(store)).toEqual([
      { kind: 'note', path: PLAN },
      { kind: 'note', path: OTHER },
    ]);
    openNote(store, PLAN, 'split');
    expect(workspaceNow(store).panes).toHaveLength(2);
  });
});

describe('opening a PDF (#504)', () => {
  const PDF = createVaultPath('Library/The Lantern Keepers.pdf');

  it('opens a PDF from Pages or search in the reader, not as a note', () => {
    const { store } = following();
    openNote(store, PDF);
    expect(placesOf(store)).toEqual([{ kind: 'document', path: PDF }]);
  });

  it('opens a PDF at a highlight: the reader tab is asked to reveal its block', () => {
    const wiring = following();
    openNote(wiring.store, PLAN);
    openDocumentAt(wiring, { path: PDF, highlightId: 'k3x9q2', how: 'new-tab' });
    expect(placesOf(wiring.store)).toEqual([
      { kind: 'note', path: PLAN },
      { kind: 'document', path: PDF },
    ]);
    const tab = workspaceNow(wiring.store).panes[0]?.active ?? '';
    expect(wiring.reveals.getState().byTab.get(tab)).toMatchObject({
      path: PDF,
      reveal: { fragment: { kind: 'block', id: 'k3x9q2' } },
    });
  });

  it('opens a PDF at its start, asking no reveal, when no highlight is named', () => {
    const wiring = following();
    openDocumentAt(wiring, { path: PDF, highlightId: null });
    expect(placesOf(wiring.store)).toEqual([{ kind: 'document', path: PDF }]);
    expect(wiring.reveals.getState().byTab.size).toBe(0);
  });
});

describe('followLink', () => {
  it('opens the note in the pane the link was clicked in, and scrolls to its heading', () => {
    const wiring = following();
    openNote(wiring.store, PLAN);
    splitPane(wiring.store);

    followLink(wiring, { pane: 0, target: 'Other', heading: '#Goals' });

    expect(placesOf(wiring.store, 0)).toEqual([{ kind: 'note', path: OTHER }]);
    expect(placesOf(wiring.store, 1)).toEqual([{ kind: 'note', path: PLAN }]);
    expect(workspaceNow(wiring.store).focused).toBe(0);
    const tab = workspaceNow(wiring.store).panes[0]?.active ?? '';
    expect(wiring.reveals.getState().byTab.get(tab)).toMatchObject({
      path: OTHER,
      reveal: { fragment: { kind: 'heading', heading: 'Goals' } },
    });
    expect(wiring.onProblem).toHaveBeenCalledWith(null);
  });

  it('takes a link naming no note as a place in the note it is in', () => {
    const wiring = following();
    openNote(wiring.store, PLAN);
    followLink(wiring, { pane: 0, target: '', heading: '#^abc123' });
    expect(placesOf(wiring.store)).toEqual([{ kind: 'note', path: PLAN }]);
    expect(wiring.reveals.getState().byTab.get('t1')?.reveal.fragment).toEqual({
      kind: 'block',
      id: 'abc123',
    });
  });

  it('opens the link in a new tab beside the clicked tab on ⌘-click, and beside on ⌘⇧-click', () => {
    const wiring = following();
    openNote(wiring.store, PLAN);
    splitPane(wiring.store);
    followLink(wiring, { pane: 0, target: 'Other', heading: '#Goals', how: 'new-tab' });
    expect(placesOf(wiring.store, 0)).toEqual([
      { kind: 'note', path: PLAN },
      { kind: 'note', path: OTHER },
    ]);
    expect(placesOf(wiring.store, 1)).toEqual([{ kind: 'note', path: PLAN }]);
    expect(workspaceNow(wiring.store).focused).toBe(0);
    const tab = workspaceNow(wiring.store).panes[0]?.active ?? '';
    expect(wiring.reveals.getState().byTab.get(tab)?.path).toBe(OTHER);

    const split = following();
    openNote(split.store, PLAN);
    followLink(split, { pane: 0, target: 'Other', how: 'split' });
    expect(placesOf(split.store, 1)).toEqual([{ kind: 'note', path: OTHER }]);
    expect(placesOf(split.store, 0)).toEqual([{ kind: 'note', path: PLAN }]);
  });

  it('reports a link that leads nowhere and opens nothing', () => {
    const wiring = following();
    openNote(wiring.store, PLAN);
    followLink(wiring, { pane: 0, target: 'Missing' });
    expect(wiring.onProblem).toHaveBeenCalledWith('No note called "Missing"');
    expect(placesOf(wiring.store)).toEqual([{ kind: 'note', path: PLAN }]);
    expect(wiring.reveals.getState().byTab.size).toBe(0);
  });
});

describe('clickLink (slice 6b)', () => {
  const peeking = () => ({ ...following(), overlays: createOverlayStore() });

  it('peeks the note a link names on a plain click, leaving the pane where it was', () => {
    const wiring = peeking();
    openNote(wiring.store, PLAN);
    clickLink(wiring, { pane: 0, target: 'Other', how: 'here', inPeek: false });
    expect(peekNow(wiring.overlays)).toEqual({ path: OTHER, from: null });
    expect(placesOf(wiring.store)).toEqual([{ kind: 'note', path: PLAN }]);
    expect(wiring.onProblem).toHaveBeenCalledWith(null);
  });

  it('shows the linked note in place in the peek, when clicked inside it', () => {
    const wiring = peeking();
    openPeek(wiring.overlays, { path: PLAN, from: { within: 'Tasks', order: [PLAN], index: 0 } });
    clickLink(wiring, { pane: 0, target: 'Other', how: 'here', inPeek: true });
    expect(peekNow(wiring.overlays)).toEqual({ path: OTHER, from: null });
  });

  it('says a link leads nowhere, and peeks nothing', () => {
    const wiring = peeking();
    clickLink(wiring, { pane: 0, target: 'Missing', how: 'here', inPeek: false });
    expect(peekNow(wiring.overlays)).toBeNull();
    expect(wiring.onProblem).toHaveBeenCalledWith('No note called "Missing"');
  });

  it('opens the page for a ⌘-click, a heading, or the link menu, closing the peek', () => {
    const wiring = peeking();
    openNote(wiring.store, PLAN);
    openPeek(wiring.overlays, { path: PLAN, from: null });
    clickLink(wiring, { pane: 0, target: 'Other', how: 'new-tab', inPeek: true });
    expect(peekNow(wiring.overlays)).toBeNull();
    expect(placesOf(wiring.store)).toEqual([
      { kind: 'note', path: PLAN },
      { kind: 'note', path: OTHER },
    ]);

    const heading = peeking();
    openNote(heading.store, PLAN);
    clickLink(heading, { pane: 0, target: 'Other', heading: '#Goals', how: 'here', inPeek: false });
    expect(peekNow(heading.overlays)).toBeNull();
    expect(placesOf(heading.store)).toEqual([{ kind: 'note', path: OTHER }]);

    const menu = peeking();
    openNote(menu.store, PLAN);
    clickLink(menu, { pane: 0, target: 'Other', inPeek: false });
    expect(placesOf(menu.store)).toEqual([{ kind: 'note', path: OTHER }]);
  });

  it('peeks nothing while a menu is up, by the layer rule', () => {
    const wiring = peeking();
    showOverlay(wiring.overlays, 'new-note-menu');
    clickLink(wiring, { pane: 0, target: 'Other', how: 'here', inPeek: false });
    expect(peekNow(wiring.overlays)).toBeNull();
  });
});
