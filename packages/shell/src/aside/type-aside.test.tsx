// @vitest-environment jsdom
/**
 * The aside's Type tab (slice 12): offered beside a type's page and its
 * views, drawn as the type editor, and written to the type file through the
 * real markdown adapter, every other byte kept.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  activeTabOf,
  createVaultPath,
  EMPTY_WORKSPACE,
  openInActiveTab,
  parseObjectType,
  splitFrontmatter,
  type NavigationPlace,
} from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, type DefinedType } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { createIndexStatusStore } from '../index/index-status-store.ts';
import { createOverlayStore } from '../overlay-store.ts';
import { createRevealStore } from '../panes/reveals.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { createWorkspaceStore, loadVault, workspaceNow } from '../workspace/workspace-store.ts';
import { WorkspaceStoresProvider } from '../workspace/workspace-wiring.tsx';
import { AsideContainer } from './aside-container.tsx';
import { createAsideStore, showAsideTab } from './aside-store.ts';
import { ClaudeSeatProvider } from './claude-seat.tsx';
import type { RowPorts } from './row-aside.tsx';
import { createShownNotes } from './shown-notes.ts';
import type { TypeAsideWiring } from './type-aside.tsx';

const TYPE_PATH = '.atlas/types/meeting.md';
// Hand-written: a comment, an odd spacing and a body, none of which the editor may touch.
const TYPE_FILE = [
  '---',
  'name: meeting',
  'label: Meeting',
  '# kept as written',
  'properties:',
  '  date:   date',
  '  people:',
  '    kind: relation',
  '    target: person',
  '    many: true',
  '---',
  '',
  '# Meeting',
  '',
  'Notes from a meeting.',
  '',
].join('\n');
const VIEW = createVaultPath('.atlas/views/Meeting table.md');

function vault() {
  const files = new Map([[TYPE_PATH, TYPE_FILE]]);
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({ text: files.get(path) ?? '', modified: 1 }),
    writeTextFile: async ({ path, contents }) => {
      files.set(path, contents);
      return 2;
    },
  });
  const { frontmatter } = splitFrontmatter(TYPE_FILE);
  const meeting: DefinedType = {
    ...parseObjectType(remarkMarkdown.frontmatterProperties(frontmatter)),
    path: createVaultPath(TYPE_PATH),
  };
  return { files, fs, meeting };
}

function show(place: NavigationPlace, chosen: 'type' | 'properties' = 'type') {
  const { files, fs, meeting } = vault();
  const store = createWorkspaceStore({
    remembered: { read: () => openInActiveTab(EMPTY_WORKSPACE, place), write: () => {} },
  });
  loadVault(store, '/v');
  const aside = createAsideStore({ remembered: { read: () => null, write: () => {} } });
  showAsideTab(aside, chosen);
  const stores = {
    store,
    aside,
    shown: createShownNotes(),
    reveals: createRevealStore(),
    overlays: createOverlayStore(),
    nameOf: () => 'Meeting',
    tab: activeTabOf(workspaceNow(store)).id,
  };
  const onTypeSaved = vi.fn(async () => null);
  const rows = {
    pane: {
      notes: { fs, markdown: remarkMarkdown },
      index: fakeIndexPort(),
      editors: { setPropertiesIfOpen: async () => false },
      indexStatus: createIndexStatusStore(),
      vault: '/v',
      types: [meeting],
      notePaths: [],
      savedViews: [{ path: VIEW, title: 'Meeting table', type: 'meeting' }],
      viewPaths: [VIEW],
      onTypeSaved,
    },
    openNote: vi.fn(),
  } as unknown as RowPorts;
  const wiring: TypeAsideWiring = {
    onDelete: vi.fn(),
    onEditTemplate: vi.fn(),
    onOpenType: vi.fn(),
  };
  render(
    <WorkspaceStoresProvider value={stores}>
      <ClaudeSeatProvider value={<p>the chat</p>}>
        <AsideContainer rows={rows} types={wiring} />
      </ClaudeSeatProvider>
    </WorkspaceStoresProvider>,
    { wrapper: queryWrapper().wrapper },
  );
  return { files, rows, wiring, onTypeSaved };
}

const tabs = () => screen.getAllByRole('tab').map((each) => each.textContent);

describe('the aside’s Type tab', () => {
  it('is offered first beside a type’s page, and shows that type’s editor', () => {
    show({ kind: 'type', name: 'meeting' });
    expect(tabs()).toEqual(['Type', 'Properties', 'Claude']);
    const name = screen.getByRole('textbox', { name: 'Name of this type' });
    expect((name as HTMLInputElement).value).toBe('Meeting');
    expect(document.querySelector('.aside--type')).not.toBeNull();
    expect(screen.getByText('Saved · edits apply to every Meeting note')).toBeDefined();
  });

  it('is offered beside one of the type’s views too', () => {
    show({ kind: 'note', path: VIEW });
    expect(tabs()[0]).toBe('Type');
  });

  it('is not offered beside a note that is not a view, nor a page of another kind', () => {
    show({ kind: 'note', path: createVaultPath('Standup.md') }, 'properties');
    expect(tabs()).not.toContain('Type');
  });

  it('leaves the chosen tab alone: Properties stays shown on a type page, with Type beside it', () => {
    show({ kind: 'type', name: 'meeting' }, 'properties');
    expect(tabs()).toEqual(['Type', 'Properties', 'Claude']);
    expect(screen.getByRole('tab', { name: 'Properties' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(document.querySelector('.aside--type')).toBeNull();
  });

  it('writes Required on new notes to the type file, keeping every other byte', async () => {
    const { files, onTypeSaved } = show({ kind: 'type', name: 'meeting' });
    await userEvent.click(screen.getByRole('button', { name: 'Edit Date' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Required on new notes' }));
    await waitFor(() => expect(onTypeSaved).toHaveBeenCalled());
    expect(files.get(TYPE_PATH)).toBe(
      TYPE_FILE.replace('  date:   date\n', '  date:\n    kind: date\n    required: true\n'),
    );
  });

  it('opens the template and the default view from its rows', async () => {
    const { rows, wiring } = show({ kind: 'type', name: 'meeting' });
    await userEvent.click(screen.getByRole('button', { name: 'Template: Meeting' }));
    expect(wiring.onEditTemplate).toHaveBeenCalledWith('meeting');
    await userEvent.click(screen.getByRole('button', { name: 'Default view: Meeting table' }));
    expect(rows.openNote).toHaveBeenCalledWith(VIEW);
  });
});
