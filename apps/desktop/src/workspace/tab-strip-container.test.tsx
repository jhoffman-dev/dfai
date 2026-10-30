// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, type NavigationPlace } from '@dfai/domain';
import { createAsideStore } from '../aside/aside-store.ts';
import { createShownNotes } from '../aside/shown-notes.ts';
import { createOverlayStore } from '../overlay-store.ts';
import { createRevealStore } from '../panes/reveals.ts';
import { TabStripContainer } from './tab-strip-container.tsx';
import {
  createWorkspaceStore,
  loadVault,
  openPlace,
  splitPane,
  workspaceNow,
  type WorkspaceStore,
} from './workspace-store.ts';
import { WorkspaceStoresProvider } from './workspace-wiring.tsx';

const note = (name: string): NavigationPlace => ({
  kind: 'note',
  path: createVaultPath(`${name}.md`),
});

/** The window's other stores, none of which the strip reads. */
const windowStores = () => ({
  reveals: createRevealStore(),
  overlays: createOverlayStore(),
  aside: createAsideStore({ remembered: { read: () => null, write: () => {} } }),
  shown: createShownNotes(),
});

/** What a place is called here: a note by its file's name, a page by its kind. */
const nameOf = (place: NavigationPlace) =>
  place.kind === 'note' ? place.path.replace(/\.md$/, '') : place.kind;

function show(store: WorkspaceStore, { pane = 0, focused = true } = {}) {
  return render(
    <WorkspaceStoresProvider value={{ store, ...windowStores(), nameOf }}>
      <TabStripContainer pane={pane} focused={focused} />
    </WorkspaceStoresProvider>,
  );
}

function openOn(...places: NavigationPlace[]) {
  const store = createWorkspaceStore({ remembered: { read: () => null, write: () => {} } });
  loadVault(store, '/v');
  places.forEach((place, at) => openPlace(store, place, at === 0 ? 'here' : 'new-tab'));
  return store;
}

describe('TabStripContainer', () => {
  it('names each tab by its place, an empty tab "New tab", and marks the shown one', () => {
    const store = openOn(note('alpha'), { kind: 'today' });
    store.setState((state) => ({
      workspace: {
        ...state.workspace,
        panes: [
          {
            active: 't2',
            tabs: [
              ...(state.workspace.panes[0]?.tabs ?? []),
              { id: 't9', pinned: false, history: { back: [], current: null, forward: [] } },
            ],
          },
        ],
      },
    }));
    show(store);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['alpha', 'today', 'New tab']);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(screen.getByRole('tablist', { name: 'Pane 1 tabs' })).toBeDefined();
  });

  it('gives every kind of place its glyph, and an empty tab none', () => {
    const kinds: NavigationPlace[] = [
      note('alpha'),
      { kind: 'type', name: 'task' },
      { kind: 'query' },
      { kind: 'graph', scope: { kind: 'vault' } },
      { kind: 'tags', tag: null },
      { kind: 'archive' },
      { kind: 'inbox' },
      { kind: 'review' },
      { kind: 'today' },
      { kind: 'automations' },
      { kind: 'activity' },
      { kind: 'templates' },
      { kind: 'terms' },
      { kind: 'skills' },
    ];
    const store = openOn(...kinds);
    const { container } = show(store);
    const icons = [...container.querySelectorAll('.tab-strip__icon')];
    expect(icons).toHaveLength(kinds.length);
    // Each kind draws the glyph meant for it, not one glyph for all.
    expect(
      new Set(icons.map((icon) => icon.getAttribute('data-icon') ?? icon.innerHTML)).size,
    ).toBeGreaterThan(5);
  });

  it('hands a click, a close and the + to the store, for its own pane', async () => {
    const store = openOn(note('alpha'), note('beta'));
    splitPane(store);
    show(store, { pane: 0, focused: false });
    await userEvent.click(screen.getByRole('tab', { name: 'alpha' }));
    expect(workspaceNow(store).panes[0]?.active).toBe('t1');
    expect(workspaceNow(store).focused).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: 'New tab' }));
    expect(workspaceNow(store).panes[0]?.tabs).toHaveLength(3);
    expect(workspaceNow(store).panes[1]?.tabs).toHaveLength(1);

    const shown = screen.getByRole('tab', { name: 'New tab' });
    await userEvent.click(within(shown.parentElement as HTMLElement).getByTitle('Close New tab'));
    expect(workspaceNow(store).panes[0]?.tabs.map((tab) => tab.id)).toEqual(['t1', 't2']);
  });

  it('says whether its pane is the focused one', () => {
    const store = openOn(note('alpha'));
    const { container, rerender } = show(store, { focused: true });
    expect(container.querySelector('.tab-strip--focused')).not.toBeNull();
    rerender(
      <WorkspaceStoresProvider value={{ store, ...windowStores(), nameOf }}>
        <TabStripContainer pane={0} focused={false} />
      </WorkspaceStoresProvider>,
    );
    expect(container.querySelector('.tab-strip--focused')).toBeNull();
  });
});
