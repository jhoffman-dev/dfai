// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  activeTabOf,
  createVaultPath,
  EMPTY_WORKSPACE,
  NO_LINKS,
  openInActiveTab,
  type EditorNode,
  type NavigationPlace,
  type PropertyDef,
  type VaultPath,
} from '@dfai/domain';
import type { PropertyRow } from '@dfai/ui';
import { createIndexStatusStore } from '../index/index-status-store.ts';
import { createOverlayStore } from '../overlay-store.ts';
import { createRevealStore } from '../panes/reveals.ts';
import { createWorkspaceStore, loadVault, workspaceNow } from '../workspace/workspace-store.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { WorkspaceStoresProvider } from '../workspace/workspace-wiring.tsx';
import { AsideContainer } from './aside-container.tsx';
import { createAsideStore, focusRow, showAsideTab } from './aside-store.ts';
import { ClaudeSeatProvider } from './claude-seat.tsx';
import type { RowPorts } from './row-aside.tsx';
import {
  createShownNotes,
  publishShownDoc,
  publishShownNote,
  type ShownNote,
} from './shown-notes.ts';

const NOTE = createVaultPath('Tasks/Ship it.md');

const row = (key: string, value: unknown): PropertyRow => ({
  def: {
    key,
    kind: 'text',
    label: key[0]!.toUpperCase() + key.slice(1),
    required: false,
    options: [],
    target: null,
    many: false,
  } satisfies PropertyDef,
  value,
  error: null,
});

const heading = (text: string): EditorNode => ({
  type: 'heading',
  attrs: { level: 2 },
  content: [{ type: 'text', text }],
});

/** The window's stores, with one vault open on `place`. */
function openOn(place: NavigationPlace) {
  const store = createWorkspaceStore({
    remembered: { read: () => openInActiveTab(EMPTY_WORKSPACE, place), write: () => {} },
  });
  loadVault(store, '/v');
  const aside = createAsideStore({ remembered: { read: () => null, write: () => {} } });
  showAsideTab(aside, 'properties');
  return {
    store,
    aside,
    shown: createShownNotes(),
    reveals: createRevealStore(),
    overlays: createOverlayStore(),
    nameOf: () => 'Ship it',
    tab: activeTabOf(workspaceNow(store)).id,
  };
}

function published(path: VaultPath, onChange = vi.fn()): ShownNote {
  return {
    path,
    title: 'Ship it',
    kicker: 'Task',
    panel: { typeName: 'task', rows: [row('owner', 'Mara Quill')], relationChoices: {}, onChange },
    links: NO_LINKS,
    mentions: { kind: 'idle' },
    onFindMentions: vi.fn(),
    onLinkMention: vi.fn(),
  };
}

// A row's note is read through these; the read here never answers, so the
// row's pane stays at "Reading…" and nothing else of the ports is touched.
const ROWS = {
  pane: {
    notes: { fs: { readTextFile: () => new Promise(() => {}) }, markdown: {} },
    indexStatus: createIndexStatusStore(),
    vault: '/v',
    types: [],
    savedViews: [],
    notePaths: [],
  },
  openNote: vi.fn(),
} as unknown as RowPorts;

function show(stores: ReturnType<typeof openOn>, claude = <p>the chat</p>) {
  return render(
    <WorkspaceStoresProvider value={stores}>
      <ClaudeSeatProvider value={claude}>
        <AsideContainer
          rows={ROWS}
          types={{ onDelete: () => {}, onEditTemplate: () => {}, onOpenType: () => {} }}
        />
      </ClaudeSeatProvider>
    </WorkspaceStoresProvider>,
    { wrapper: queryWrapper().wrapper },
  );
}

describe('AsideContainer', () => {
  it('shows the focused tab’s note as the tab published it, and writes through its onChange', async () => {
    const stores = openOn({ kind: 'note', path: NOTE });
    const onChange = vi.fn();
    publishShownNote(stores.shown, stores.tab, published(NOTE, onChange));
    show(stores);

    const aside = screen.getByRole('complementary', { name: 'Right sidebar' });
    expect(within(aside).getByText('Task')).toBeDefined();
    expect(within(aside).getByRole('heading', { name: 'Ship it' })).toBeDefined();
    const owner = within(aside).getByRole('textbox', { name: 'Owner' });
    expect((owner as HTMLInputElement).value).toBe('Mara Quill');
    await userEvent.clear(owner);
    await userEvent.type(owner, 'Tobias Fenn{Enter}');
    expect(onChange).toHaveBeenCalledWith('owner', 'Tobias Fenn');
  });

  it('offers Backlinks and Outline for a note, and the Outline asks the tab to reveal a heading', async () => {
    const stores = openOn({ kind: 'note', path: NOTE });
    publishShownNote(stores.shown, stores.tab, published(NOTE));
    publishShownDoc(stores.shown, stores.tab, {
      type: 'doc',
      content: [heading('Steps'), heading('Expected')],
    });
    show(stores);

    await userEvent.click(screen.getByRole('tab', { name: 'Outline' }));
    await userEvent.click(screen.getByRole('button', { name: 'Expected' }));
    expect(stores.reveals.getState().byTab.get(stores.tab)).toMatchObject({
      path: NOTE,
      reveal: { fragment: { kind: 'heading', heading: 'Expected' } },
    });
    expect(stores.aside.getState().tab).toBe('outline');
  });

  it('shows the Claude tab with what the app seats there', async () => {
    const stores = openOn({ kind: 'note', path: NOTE });
    publishShownNote(stores.shown, stores.tab, published(NOTE));
    show(stores, <p>the chat</p>);
    await userEvent.click(screen.getByRole('tab', { name: 'Claude' }));
    expect(screen.getByText('the chat')).toBeDefined();
  });

  it('waits for a note the tab has not published yet, and reads the tab’s note, not another’s', () => {
    const stores = openOn({ kind: 'note', path: NOTE });
    publishShownNote(stores.shown, stores.tab, published(createVaultPath('Other.md')));
    show(stores);
    expect(screen.getByText('Reading…')).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Ship it' })).toBeNull();
  });

  it('on a page with no focused row, Properties is empty and Claude is beside it', () => {
    const stores = openOn({ kind: 'today' });
    show(stores);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Properties',
      'Claude',
    ]);
    expect(screen.getByText(/Nothing selected/)).toBeDefined();
    expect(stores.aside.getState().tab).toBe('properties');
  });

  it('a row focused on the page the tab is on takes over from the note', () => {
    const stores = openOn({ kind: 'type', name: 'task' });
    focusRow(stores.aside, { tab: stores.tab, path: NOTE, within: 'type:task' });
    show(stores);
    // The row's note is being read: Properties is offered for it.
    expect(screen.getByRole('tab', { name: 'Properties' })).toBeDefined();
    expect(screen.queryByRole('tab', { name: 'Outline' })).toBeNull();
  });

  it('× hides the aside, and Escape hands the focus back to the focused pane', async () => {
    const stores = openOn({ kind: 'note', path: NOTE });
    publishShownNote(stores.shown, stores.tab, published(NOTE));
    const pane = document.createElement('section');
    pane.className = 'pane pane--focused';
    pane.tabIndex = -1;
    document.body.append(pane);
    show(stores);

    screen.getByRole('tab', { name: 'Properties' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).toBe(pane);

    await userEvent.click(screen.getByRole('button', { name: 'Hide right sidebar' }));
    expect(stores.aside.getState().open).toBe(false);
    pane.remove();
  });
});
