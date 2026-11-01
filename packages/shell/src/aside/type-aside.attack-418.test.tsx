// @vitest-environment jsdom
/**
 * Attack on PR #418 (slice 12): the type editor in the aside, written through
 * the real markdown adapter. Each test holds one invariant of a type-file
 * write (ADR-0003): the change asked for lands, and every other byte stays.
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

/** The aside on the Type tab of `meeting`, whose file is `text`; `others` are the vault's other types. */
function show(text: string, others: readonly string[] = ['person']) {
  const files = new Map([[TYPE_PATH, text]]);
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({ text: files.get(path) ?? '', modified: 1 }),
    writeTextFile: async ({ path, contents }) => {
      files.set(path, contents);
      return 2;
    },
  });
  const { frontmatter } = splitFrontmatter(text);
  const meeting: DefinedType = {
    ...parseObjectType(remarkMarkdown.frontmatterProperties(frontmatter)),
    path: createVaultPath(TYPE_PATH),
  };
  const known: DefinedType[] = others.map((name) => ({
    ...parseObjectType({ name, label: name, properties: {} }),
    path: createVaultPath(`.atlas/types/${name}.md`),
  }));
  const store = createWorkspaceStore({
    remembered: {
      read: () => openInActiveTab(EMPTY_WORKSPACE, { kind: 'type', name: 'meeting' }),
      write: () => {},
    },
  });
  loadVault(store, '/v');
  const aside = createAsideStore({ remembered: { read: () => null, write: () => {} } });
  showAsideTab(aside, 'type');
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
      types: [meeting, ...known],
      notePaths: [],
      savedViews: [],
      viewPaths: [],
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
  return { files, onTypeSaved };
}

const lines = (...each: string[]) => each.join('\n');

describe('the aside’s type editor, attacked (#418)', () => {
  it('Allow many on a relation that points at a type the vault does not define writes many: true', async () => {
    // Hand-written ahead of the type it points at, or left behind by a deleted one.
    const text = lines(
      '---',
      'name: meeting',
      'label: Meeting',
      'properties:',
      '  venue:',
      '    kind: relation',
      '    target: venue',
      '---',
      '',
    );
    const { files, onTypeSaved } = show(text);
    await userEvent.click(screen.getByRole('button', { name: 'Edit Venue' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Allow many' }));
    await waitFor(() => expect(onTypeSaved).toHaveBeenCalled());
    expect(screen.queryByText(/There is no type called/)).toBeNull();
    expect(files.get(TYPE_PATH)).toBe(
      text.replace('    target: venue\n', '    target: venue\n    many: true\n'),
    );
  });

  it('Required ticked on then off again leaves the type file byte-for-byte as it was', async () => {
    // CRLF, as a file from Windows has it; the shorthand `date: date` is how it was written.
    const text = [
      '---',
      'name: meeting',
      'label: Meeting',
      'properties:',
      '  date: date',
      '---',
      '',
      '# Meeting',
      '',
    ].join('\r\n');
    const { files, onTypeSaved } = show(text);
    await userEvent.click(screen.getByRole('button', { name: 'Edit Date' }));
    const required = screen.getByRole('checkbox', { name: 'Required on new notes' });
    await userEvent.click(required);
    await userEvent.click(required);
    await waitFor(() => expect(onTypeSaved).toHaveBeenCalledTimes(2));
    expect(files.get(TYPE_PATH)).toBe(text);
  });

  it('Required on a property with a unicode key is written under that key, nothing else changed', async () => {
    const text = lines(
      '---',
      'name: meeting',
      'label: Meeting',
      'properties:',
      '  fällig:',
      '    kind: date',
      '    label: Fällig am',
      '  topic: text',
      '---',
      '',
    );
    const { files, onTypeSaved } = show(text);
    await userEvent.click(screen.getByRole('button', { name: 'Edit Fällig am' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Required on new notes' }));
    await waitFor(() => expect(onTypeSaved).toHaveBeenCalled());
    expect(files.get(TYPE_PATH)).toBe(
      text.replace('    label: Fällig am\n', '    label: Fällig am\n    required: true\n'),
    );
  });

  it('Allow many ticked off again on a relation leaves the file byte-for-byte as it was', async () => {
    const text = lines(
      '---',
      'name: meeting',
      'label:   Meeting',
      '# who came',
      'properties:',
      '  people:',
      '    kind: relation',
      '    target: person',
      '  many: text',
      '---',
      '',
    );
    const { files, onTypeSaved } = show(text);
    await userEvent.click(screen.getByRole('button', { name: 'Edit People' }));
    const many = screen.getByRole('checkbox', { name: 'Allow many' });
    await userEvent.click(many);
    await userEvent.click(many);
    await waitFor(() => expect(onTypeSaved).toHaveBeenCalledTimes(2));
    expect(files.get(TYPE_PATH)).toBe(text);
  });
});
