// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  parseObjectType,
  savedViewSummary,
  splitFrontmatter,
  typeViews,
  type SavedViewSummary,
  type VaultPath,
} from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, loadSidebarCatalog, memoryVault } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import type { TypeTabStore } from './browser-type-tab-store.ts';
import { typeTabsShown } from './type-tabs.ts';
import { useTypeViews, type AskDelete } from './use-type-views.ts';

/**
 * Issue #11 (ADR-0023): a type's tabs, wired to the vault. The catalogue is
 * read again only after a write lands, so these hold it still — as it is for
 * the moment a person presses a key twice.
 */

const TASK = parseObjectType({
  name: 'task',
  label: 'Task',
  properties: { status: { kind: 'select', options: ['backlog', 'done'] } },
});

const view = (layout: string, order?: number) =>
  [
    '---',
    'atlas: view',
    'type: task',
    `layout: ${layout}`,
    ...(order === undefined ? [] : [`order: ${order}`]),
    '---',
    '',
  ].join('\n');

/** No pane holds a view here, so every property write goes to the file. */
const NO_EDITORS: OpenEditors = {
  register: () => {},
  setPropertiesIfOpen: async () => false,
  savePane: () => {},
  reloadOthers: () => {},
};

function memoryStore(): TypeTabStore & { saved: Map<string, string> } {
  const saved = new Map<string, string>();
  return {
    saved,
    read: ({ vault, type }) => saved.get(`${vault}/${type}`) ?? null,
    write: ({ vault, type, path }) => saved.set(`${vault}/${type}`, path),
  };
}

function setUp(
  files: Record<string, string>,
  {
    askDelete = (_entry, onDeleted) => onDeleted(),
    failWrites = false,
  }: { askDelete?: AskDelete; failWrites?: boolean } = {},
) {
  const memory = memoryVault(files);
  const fs = fakeVaultFs({
    ...memory.fs,
    ...(failWrites && {
      writeTextFile: async () => {
        throw new Error('The disk is full.');
      },
    }),
  });
  const read = (): SavedViewSummary[] =>
    [...memory.files.keys()].flatMap((path) => {
      const { frontmatter } = splitFrontmatter(memory.files.get(path) ?? '');
      const summary = savedViewSummary(
        path as VaultPath,
        remarkMarkdown.frontmatterProperties(frontmatter),
      );
      return summary === null ? [] : [summary];
    });
  const onChanged = vi.fn();
  const onOpenType = vi.fn();
  const onEditTemplate = vi.fn();
  const store = memoryStore();
  const props = {
    ports: { fs, markdown: remarkMarkdown, editors: NO_EDITORS },
    types: [TASK],
    vaultKey: '/vaults/work',
    store,
    onChanged,
    onOpenType,
    onEditTemplate,
    askDelete,
  };
  // The catalogue as first read, and not again unless a test says so.
  const catalogue = read();
  const hook = renderHook(
    ({ savedViews }) =>
      useTypeViews({ ...props, savedViews, viewPaths: savedViews.map((each) => each.path) }),
    { initialProps: { savedViews: catalogue } },
  );
  const tabs = () => typeViews(read(), 'task').map((each) => each.path.slice(13, -3));
  return { hook, memory, read, tabs, onChanged, onOpenType, onEditTemplate, store };
}

const settle = () => act(async () => {});

describe('a type’s tabs written before the catalogue is read again', () => {
  it('asks a second move of the views as the first left them', async () => {
    const { hook, tabs } = setUp({
      '.atlas/views/A.md': view('table', 1),
      '.atlas/views/B.md': view('table', 2),
      '.atlas/views/C.md': view('table', 3),
    });
    const onOpenView = vi.fn();
    const editing = hook.result.current.editingFor({ typeName: 'task', onOpenView })!;

    // Alt+← on B, then on C: the tabs show B, A, C after the first, so C asks for place 1.
    void editing.onMove({ path: '.atlas/views/B.md', to: 0 });
    void editing.onMove({ path: '.atlas/views/C.md', to: 1 });
    await settle();

    expect(tabs()).toEqual(['B', 'C', 'A']);
    expect(hook.result.current.error).toBeNull();
  });

  it('names a second view added by a quick second “+” past the first', async () => {
    const { hook, memory } = setUp({ '.atlas/views/Board.md': view('table', 1) });
    const onOpenView = vi.fn();
    const editing = hook.result.current.editingFor({ typeName: 'task', onOpenView })!;

    editing.onAdd('list');
    editing.onAdd('list');
    await settle();

    expect(hook.result.current.error).toBeNull();
    expect(memory.files.has('.atlas/views/Task list.md')).toBe(true);
    expect(memory.files.has('.atlas/views/Task list 2.md')).toBe(true);
    expect(onOpenView.mock.calls.map(([path]) => path)).toEqual([
      '.atlas/views/Task list.md',
      '.atlas/views/Task list 2.md',
    ]);
  });

  it('moves a view the page has open before the catalogue has read it', async () => {
    const { hook, memory, tabs } = setUp({ '.atlas/views/Board.md': view('table', 1) });
    // Written a moment ago — by the "+" in another window, say — and open here.
    await memory.fs.createNote({
      path: '.atlas/views/Fresh.md' as VaultPath,
      contents: view('list', 2),
    });
    const current = savedViewSummary('.atlas/views/Fresh.md' as VaultPath, {
      atlas: 'view',
      type: 'task',
      layout: 'list',
      order: 2,
    })!;
    const editing = hook.result.current.editingFor({
      typeName: 'task',
      onOpenView: vi.fn(),
      current,
    })!;

    await act(async () => {
      await editing.onMove({ path: current.path, to: 0 });
    });

    expect(tabs()).toEqual(['Fresh', 'Board']);
  });
});

describe('deleting a tab', () => {
  const three = {
    '.atlas/views/A.md': view('table', 1),
    '.atlas/views/B.md': view('table', 2),
    '.atlas/views/C.md': view('table', 3),
  };

  it('lands on the next tab, else the one before', () => {
    const { hook } = setUp(three);
    const onOpenView = vi.fn();
    const editing = hook.result.current.editingFor({ typeName: 'task', onOpenView })!;
    editing.onDelete('.atlas/views/B.md');
    editing.onDelete('.atlas/views/C.md');
    expect(onOpenView.mock.calls.map(([path]) => path)).toEqual([
      '.atlas/views/C.md',
      '.atlas/views/B.md',
    ]);
  });

  it('opens the type’s default table once its last view is gone', () => {
    const { hook, onOpenType } = setUp({ '.atlas/views/A.md': view('table', 1) });
    const onOpenView = vi.fn();
    hook.result.current.editingFor({ typeName: 'task', onOpenView })!.onDelete('.atlas/views/A.md');
    expect(onOpenType).toHaveBeenCalledExactlyOnceWith('task', 'notes');
    expect(onOpenView).not.toHaveBeenCalled();
  });

  it('lands nowhere when the question is turned down', () => {
    const { hook, onOpenType } = setUp(three, { askDelete: () => {} });
    const onOpenView = vi.fn();
    hook.result.current.editingFor({ typeName: 'task', onOpenView })!.onDelete('.atlas/views/A.md');
    expect(onOpenView).not.toHaveBeenCalled();
    expect(onOpenType).not.toHaveBeenCalled();
  });

  it('opens a type on its first tab once the one it remembers is deleted', () => {
    const { hook, read, memory } = setUp(three);
    hook.result.current.remember('.atlas/views/B.md' as VaultPath);
    expect(hook.result.current.landing('task')).toBe('.atlas/views/B.md');
    memory.files.delete('.atlas/views/B.md');
    hook.rerender({ savedViews: read() });
    expect(hook.result.current.landing('task')).toBe('.atlas/views/A.md');
  });
});

describe('a write that fails', () => {
  it('says why, and hands the failure to the tabs so a move can be put back', async () => {
    const { hook, onChanged } = setUp(
      { '.atlas/views/A.md': view('table', 1), '.atlas/views/B.md': view('table', 2) },
      { failWrites: true },
    );
    const editing = hook.result.current.editingFor({ typeName: 'task', onOpenView: vi.fn() })!;

    let moved: unknown;
    await act(async () => {
      moved = editing.onMove({ path: '.atlas/views/A.md', to: 1 });
      await (moved as Promise<unknown>).catch(() => undefined);
    });

    await expect(moved).rejects.toThrow('The disk is full.');
    expect(hook.result.current.error).toBe('The disk is full.');
    // Re-read all the same, so the tabs show what the files now say.
    expect(onChanged).toHaveBeenCalled();
  });

  it('does not hold up the writes asked after it', async () => {
    const { hook, memory } = setUp({ '.atlas/views/A.md': view('table', 1) });
    const editing = hook.result.current.editingFor({ typeName: 'task', onOpenView: vi.fn() })!;

    editing.onAdd('calendar'); // Task has no date, so this is refused
    editing.onAdd('list');
    await settle();

    expect(memory.files.has('.atlas/views/Task list.md')).toBe(true);
    expect(hook.result.current.error).toMatch(/calendar needs a date/);
  });
});

describe('which type a view is of', () => {
  it('is the type it lists while the vault defines that type, and none otherwise', () => {
    const { hook, store } = setUp({
      '.atlas/views/A.md': view('table', 1),
      '.atlas/views/Gone.md': ['---', 'atlas: view', 'type: ghost', '---', ''].join('\n'),
    });
    expect(hook.result.current.ownerOf('.atlas/views/A.md' as VaultPath)).toBe('task');
    expect(hook.result.current.ownerOf('.atlas/views/Gone.md' as VaultPath)).toBeNull();
    hook.result.current.remember('.atlas/views/Gone.md' as VaultPath);
    expect(store.saved.size).toBe(0);
  });

  it('opens the type’s own template from beside its tabs (ADR-0026)', () => {
    const { hook, onEditTemplate, onOpenType } = setUp({});
    hook.result.current.editingFor({ typeName: 'task', onOpenView: vi.fn() })!.onEditTemplate!();
    expect(onEditTemplate).toHaveBeenCalledExactlyOnceWith('task');
    expect(onOpenType).not.toHaveBeenCalled();
  });

  it('offers no tab commands for a type the vault does not define', () => {
    const { hook } = setUp({});
    expect(hook.result.current.editingFor({ typeName: 'ghost', onOpenView: vi.fn() })).toBe(
      undefined,
    );
  });
});

describe('the default table a type with no views shows', () => {
  it('is written under the very name and path its tab showed', async () => {
    const memory = memoryVault({
      // A Project view lifted to Inbox by its title, a note that is no view,
      // and one taken in another case: each holds a name the default could take.
      '.atlas/views/Task table.md': [
        '---',
        'atlas: view',
        'type: project',
        'layout: table',
        'title: Inbox',
        '---',
        '',
      ].join('\n'),
      '.atlas/views/Task table 2.md': '# Scratch\n',
      '.atlas/views/TASK TABLE 3.md': '# Shouting\n',
    });
    const catalog = await loadSidebarCatalog({
      fs: fakeVaultFs(memory.fs),
      markdown: remarkMarkdown,
      index: fakeIndexPort(),
    });
    const [shown] = typeTabsShown(catalog, TASK);
    const hook = renderHook(() =>
      useTypeViews({
        ports: { fs: fakeVaultFs(memory.fs), markdown: remarkMarkdown, editors: NO_EDITORS },
        types: [TASK],
        // As the app hands them over: the catalogue's views and the paths it counts as taken.
        savedViews: catalog.savedViews,
        viewPaths: catalog.takenViewPaths,
        vaultKey: '/vaults/work',
        store: memoryStore(),
        onChanged: vi.fn(),
        onOpenType: vi.fn(),
        onEditTemplate: vi.fn(),
        askDelete: (_entry, onDeleted) => onDeleted(),
      }),
    );

    hook.result.current.editingFor({ typeName: 'task', onOpenView: vi.fn() })!.onAdd('list');
    await settle();

    expect(hook.result.current.error).toBeNull();
    expect(shown).toMatchObject({ path: '.atlas/views/Task table 4.md', title: 'Task table 4' });
    const { frontmatter } = splitFrontmatter(memory.files.get(shown!.path) ?? '');
    expect(remarkMarkdown.frontmatterProperties(frontmatter)).toMatchObject({
      atlas: 'view',
      type: 'task',
      layout: 'table',
    });
  });
});
