// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { remarkMarkdown } from '@dfai/adapters';
import {
  activeTabOf,
  createVaultPath,
  EMPTY_WORKSPACE,
  NO_LINKS,
  openInActiveTab,
  type NavigationPlace,
  type VaultPath,
} from '@dfai/domain';
import { createIndexStatusStore } from '../index/index-status-store.ts';
import { createOverlayStore } from '../overlay-store.ts';
import { createRevealStore } from '../panes/reveals.ts';
import {
  createWorkspaceStore,
  loadVault,
  openPlace,
  workspaceNow,
} from '../workspace/workspace-store.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { WorkspaceStoresProvider } from '../workspace/workspace-wiring.tsx';
import { AsideContainer } from './aside-container.tsx';
import { createAsideStore, focusRow, selectAsideTab, showAsideTab } from './aside-store.ts';
import { ClaudeSeatProvider } from './claude-seat.tsx';
import type { RowPorts } from './row-aside.tsx';
import { createShownNotes, publishShownNote, type ShownNote } from './shown-notes.ts';

// Attack pass on PR #387 (slice 8b, the right sidebar wired). Fictional names only.

afterEach(cleanup);

const NOTE = createVaultPath('Tasks/Ship it.md');
const ALDER = createVaultPath('People/Alder Wren.md');
const BRAMBLE = createVaultPath('People/Bramble Hart.md');

/** A vault on disk as the Tauri fs behaves: each call answers a tick later, and a write is refused once the file moved on. */
function diskOf(files: Record<string, string>, { pending = [] as string[] } = {}) {
  const held = new Map(Object.entries(files).map(([path, text]) => [path, { text, modified: 1 }]));
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const fs = {
    readTextFile: async (path: string) => {
      if (pending.includes(path)) return new Promise(() => {});
      await tick();
      const file = held.get(path);
      if (file === undefined) throw new Error(`No such file: ${path}`);
      return { ...file };
    },
    writeTextFile: async ({
      path,
      contents,
      expectedModified,
    }: {
      path: string;
      contents: string;
      expectedModified?: number;
    }) => {
      await tick();
      const file = held.get(path);
      if (file === undefined) throw new Error(`No such file: ${path}`);
      if (expectedModified !== undefined && expectedModified !== file.modified)
        throw new Error('The file changed on disk since it was read.');
      held.set(path, { text: contents, modified: file.modified + 1 });
      return { modified: file.modified + 1 };
    },
    readNotes: async () => [],
  };
  return { fs, textOf: (path: string) => held.get(path)?.text ?? '' };
}

function rowPortsOver(fs: ReturnType<typeof diskOf>['fs']): RowPorts {
  return {
    pane: {
      notes: { fs, markdown: remarkMarkdown },
      indexStatus: createIndexStatusStore(),
      vault: '/v',
      types: [],
      savedViews: [],
      notePaths: [],
      index: {},
      editors: { setPropertiesIfOpen: async () => false },
      activity: { inOpenVault: () => ({ record: () => {} }) },
      onChanged: () => {},
    },
    openNote: vi.fn(),
  } as unknown as RowPorts;
}

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

function show(stores: ReturnType<typeof openOn>, rows: RowPorts) {
  return render(
    <WorkspaceStoresProvider value={stores}>
      <ClaudeSeatProvider value={<p>the chat</p>}>
        <AsideContainer
          rows={rows}
          types={{ onDelete: () => {}, onEditTemplate: () => {}, onOpenType: () => {} }}
        />
      </ClaudeSeatProvider>
    </WorkspaceStoresProvider>,
    { wrapper: queryWrapper().wrapper },
  );
}

function published(path: VaultPath): ShownNote {
  return {
    path,
    title: 'Ship it',
    kicker: 'Task',
    panel: { typeName: 'task', rows: [], relationChoices: {}, onChange: vi.fn() },
    links: NO_LINKS,
    mentions: { kind: 'idle' },
    onFindMentions: vi.fn(),
    onLinkMention: vi.fn(),
  };
}

const person = (owner: string) => `---\nowner: ${owner}\n---\n\nNotes.\n`;

describe('the aside’s focused row (attack #387)', () => {
  it('typing a property of a focused row quickly reaches the file whole, not one keystroke of it', async () => {
    const disk = diskOf({ [ALDER]: person('Mara Quill') });
    const stores = openOn({ kind: 'type', name: 'person' });
    focusRow(stores.aside, { tab: stores.tab, path: ALDER, within: 'type:person' });
    show(stores, rowPortsOver(disk.fs));
    const owner = await screen.findByRole('textbox', { name: /owner/i });

    // Faster than the file answers: each keystroke is its own write today.
    act(() => owner.focus());
    for (const typed of ['T', 'To', 'Tob', 'Tobi', 'Tobia', 'Tobias']) {
      fireEvent.change(owner, { target: { value: typed } });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(disk.textOf(ALDER)).toContain('owner: Tobias');
  });

  it('a newly focused row never shows the previous row’s values under its own title', async () => {
    // Bramble's read never answers: the moment between the focus and the read.
    const disk = diskOf(
      { [ALDER]: person('Mara Quill'), [BRAMBLE]: person('Tobias Fenn') },
      { pending: [BRAMBLE] },
    );
    const stores = openOn({ kind: 'type', name: 'person' });
    focusRow(stores.aside, { tab: stores.tab, path: ALDER, within: 'type:person' });
    show(stores, rowPortsOver(disk.fs));
    const owner = await screen.findByRole('textbox', { name: /owner/i });
    expect((owner as HTMLInputElement).value).toBe('Mara Quill');

    act(() => focusRow(stores.aside, { tab: stores.tab, path: BRAMBLE, within: 'type:person' }));

    const aside = screen.getByRole('complementary', { name: 'Right sidebar' });
    expect(within(aside).queryByDisplayValue('Mara Quill')).toBeNull();
  });

  it('a focused row whose note has gone says so, rather than reading forever', async () => {
    const disk = diskOf({});
    const stores = openOn({ kind: 'type', name: 'person' });
    focusRow(stores.aside, { tab: stores.tab, path: ALDER, within: 'type:person' });
    show(stores, rowPortsOver(disk.fs));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByText('Reading…')).toBeNull();
  });
});

describe('the aside’s chosen tab (attack #387)', () => {
  it('passing through a page without an Outline does not forget that the person chose Outline', () => {
    const stores = openOn({ kind: 'note', path: NOTE });
    publishShownNote(stores.shown, stores.tab, published(NOTE));
    selectAsideTab(stores.aside, 'outline');
    show(stores, rowPortsOver(diskOf({}).fs));
    expect(screen.getByRole('tab', { name: 'Outline' }).getAttribute('aria-selected')).toBe('true');

    act(() => openPlace(stores.store, { kind: 'today' }, 'here'));
    act(() => openPlace(stores.store, { kind: 'note', path: NOTE }, 'here'));

    expect(stores.aside.getState().tab).toBe('outline');
  });

  it('guard: the Claude tab survives a page without a note (it is always offered)', async () => {
    const stores = openOn({ kind: 'note', path: NOTE });
    publishShownNote(stores.shown, stores.tab, published(NOTE));
    show(stores, rowPortsOver(diskOf({}).fs));
    await userEvent.click(screen.getByRole('tab', { name: 'Claude' }));
    act(() => openPlace(stores.store, { kind: 'today' }, 'here'));
    expect(stores.aside.getState().tab).toBe('claude');
    expect(screen.getByText('the chat')).toBeDefined();
  });

  it('guard: a row focused on another page of the same tab is not shown', () => {
    const stores = openOn({ kind: 'type', name: 'person' });
    focusRow(stores.aside, { tab: stores.tab, path: ALDER, within: 'type:task' });
    show(stores, rowPortsOver(diskOf({}).fs));
    expect(screen.getByText(/Nothing selected/)).toBeDefined();
  });
});

describe('the aside’s waits (attack #387)', () => {
  it('guard: a row write that lands still reads back in the aside', async () => {
    const disk = diskOf({ [ALDER]: person('Mara Quill') });
    const stores = openOn({ kind: 'type', name: 'person' });
    focusRow(stores.aside, { tab: stores.tab, path: ALDER, within: 'type:person' });
    show(stores, rowPortsOver(disk.fs));
    const owner = await screen.findByRole('textbox', { name: /owner/i });
    act(() => owner.focus());
    fireEvent.change(owner, { target: { value: 'Tobias Fenn' } });
    await waitFor(() => expect(disk.textOf(ALDER)).toContain('owner: Tobias Fenn'));
  });
});
