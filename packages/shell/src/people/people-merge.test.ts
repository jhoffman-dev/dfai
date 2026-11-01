import { describe, expect, it, vi } from 'vitest';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import type { IndexPort, MarkdownPort, QueryResult, VaultFsPort } from '@dfai/application';
import type { Overlay } from '../overlay.ts';
import {
  createPeopleMergeStore,
  peopleMergeCommands,
  type PeopleMergeDeps,
} from './people-merge.ts';

const p = createVaultPath;

/** Frontmatter as JSON between the fences. */
const markdown = {
  frontmatterProblem: () => null,
  frontmatterProperties: (frontmatter: string | null) =>
    frontmatter === null
      ? {}
      : JSON.parse(frontmatter.replace(/^---\n/, '').replace(/---\n?$/, '')),
  updateFrontmatter: (frontmatter: string | null, changes: Readonly<Record<string, unknown>>) =>
    `---\n${JSON.stringify({ ...markdown.frontmatterProperties(frontmatter), ...changes })}\n---\n`,
} as unknown as MarkdownPort;

const note = (properties: Record<string, unknown>, body = '') =>
  `---\n${JSON.stringify(properties)}\n---\n${body}`;

const PEOPLE: Record<string, Record<string, unknown>> = {
  'People/Mara Quill.md': { type: 'person', email: 'mara.quill@larkspur.example.com' },
  'Mara.md': { type: 'person', email: 'mara@larkspur.example.com' },
  'Tobias Fenn.md': { type: 'person' },
};

const rows = (columns: string[], found: unknown[][]): QueryResult => ({
  columns,
  rows: found,
  truncated: false,
});

function fakeVault({ failWrite = false } = {}) {
  const files = new Map<string, { text: string; modified: number }>(
    Object.entries(PEOPLE).map(([path, properties]) => [
      path,
      { text: note(properties, `${path} body\n`), modified: 1 },
    ]),
  );
  files.set('.atlas/settings.md', { text: note({}), modified: 1 });
  const trashed: string[] = [];
  const fs = {
    listDirectory: async () => [],
    readNotes: async (paths: readonly string[]) =>
      paths.flatMap((path) => {
        const file = files.get(path);
        return file === undefined ? [] : [{ path, ...file, size: file.text.length }];
      }),
    writeTextFile: async ({ path, contents }: { path: VaultPath; contents: string }) => {
      if (failWrite) throw new Error('The disk is full.');
      files.set(path, { text: contents, modified: 2 });
      return 2;
    },
    trashEntry: async ({ path }: { path: VaultPath }) => {
      files.delete(path);
      trashed.push(path);
    },
  } as unknown as VaultFsPort;
  const index = {
    notesOfType: async () => Object.keys(PEOPLE).map((path) => ({ path, title: path })),
    manifest: async () => [],
    remove: async () => {},
    query: async (sql: string) =>
      sql.includes('meeting links: directory')
        ? rows(
            ['path', 'title', 'type', 'key', 'value'],
            Object.entries(PEOPLE).map(([path, properties]) => [
              path,
              path.split('/').at(-1)!.replace('.md', ''),
              'person',
              properties['email'] === undefined ? null : 'email',
              properties['email'] ?? null,
            ]),
          )
        : rows(['path'], []),
  } as unknown as IndexPort;
  return { fs, index, files, trashed };
}

function setUp(options: { failWrite?: boolean; failSettings?: boolean } = {}) {
  const vault = fakeVault(options);
  const shown: Overlay[] = [];
  const written: Readonly<Record<string, unknown>>[] = [];
  const hidden: Overlay[] = [];
  const deps: PeopleMergeDeps = {
    ports: {
      fs: vault.fs,
      index: vault.index,
      markdown,
      editors: {
        state: () => 'closed',
        flush: async () => {},
        abandon: () => {},
        reload: () => {},
      },
    },
    settings: {
      save: vi.fn(async () => {}),
      update: vi.fn(async (change) => {
        if (options.failSettings === true) throw new Error('The settings note is read-only.');
        written.push(change({}));
      }),
    },
    notePaths: Object.keys(PEOPLE).map(p),
    overlay: { show: (overlay) => shown.push(overlay), hide: (overlay) => hidden.push(overlay) },
    toasts: { show: vi.fn(() => 1) },
    activity: { record: vi.fn() },
    onChanged: vi.fn(),
    closeNotes: vi.fn(),
    openActivity: vi.fn(),
  };
  const store = createPeopleMergeStore();
  const commands = peopleMergeCommands(store, () => deps);
  const settle = () =>
    vi.waitFor(() => expect(['checking', 'merging']).not.toContain(store.getState().merge?.kind));
  return { vault, deps, store, commands, shown, hidden, settle, written };
}

describe('merging from a person’s page', () => {
  it('asks who to keep among everyone else, then works out the merge', async () => {
    const { store, commands, shown, settle } = setUp();
    commands.mergeInto(p('Mara.md'));
    expect(shown).toEqual(['merge-people']);
    await vi.waitFor(() => expect(store.getState().merge?.kind).toBe('picking'));
    const picking = store.getState().merge;
    expect(picking?.kind === 'picking' && picking.choices.map((choice) => choice.name)).toEqual([
      'Mara Quill',
      'Tobias Fenn',
    ]);
    commands.pick('People/Mara Quill.md');
    await settle();
    const flow = store.getState().merge;
    expect(flow?.kind).toBe('previewed');
    expect(flow?.kind === 'previewed' && flow.preview.keep).toBe('People/Mara Quill.md');
  });

  it('merges once confirmed: the toast leads to Activity, the line is kept, the index read again', async () => {
    const { vault, deps, store, commands, hidden, settle } = setUp();
    commands.mergeInto(p('Mara.md'));
    await vi.waitFor(() => expect(store.getState().merge?.kind).toBe('picking'));
    commands.pick('People/Mara Quill.md');
    await settle();
    commands.confirm();
    await vi.waitFor(() => expect(store.getState().merge).toBeNull());
    expect(vault.trashed).toEqual(['Mara.md']);
    expect(deps.closeNotes).toHaveBeenCalledWith(['Mara.md']);
    expect(deps.onChanged).toHaveBeenCalledTimes(1);
    expect(hidden).toEqual(['merge-people']);
    const toast = vi.mocked(deps.toasts.show).mock.calls[0]![0];
    expect(toast.tone).toBe('change');
    expect(toast.message).toBe('Merged Mara into Mara Quill.');
    toast.action?.onClick();
    expect(deps.openActivity).toHaveBeenCalled();
    expect(deps.activity.record).toHaveBeenCalledWith({
      level: 'info',
      kind: 'save',
      message: toast.message,
      subject: { kind: 'note', path: 'People/Mara Quill.md' },
    });
  });

  it('says a failed merge as a warning, which the toasts keep in Activity, and keeps the person', async () => {
    const { vault, deps, store, commands, settle } = setUp({ failWrite: true });
    commands.mergeInto(p('Mara.md'));
    await vi.waitFor(() => expect(store.getState().merge?.kind).toBe('picking'));
    commands.pick('People/Mara Quill.md');
    await settle();
    commands.confirm();
    await vi.waitFor(() => expect(store.getState().merge).toBeNull());
    expect(vault.trashed).toEqual([]);
    expect(vi.mocked(deps.toasts.show).mock.calls[0]![0].tone).toBe('warning');
    expect(deps.activity.record).not.toHaveBeenCalled();
  });

  it('shows why a merge is refused, and confirming a refusal does nothing', async () => {
    const { store, commands, settle } = setUp();
    commands.mergeInto(p('Mara.md'));
    await vi.waitFor(() => expect(store.getState().merge?.kind).toBe('picking'));
    commands.pick('Nobody.md');
    await settle();
    expect(store.getState().merge).toEqual({
      kind: 'refused',
      message: 'Nobody is not there, or cannot be read.',
    });
    commands.confirm();
    expect(store.getState().merge?.kind).toBe('refused');
  });

  it('closes without merging, and not while a merge is being made', async () => {
    const { store, commands, hidden } = setUp();
    commands.mergeInto(p('Mara.md'));
    await vi.waitFor(() => expect(store.getState().merge?.kind).toBe('picking'));
    commands.closeMerge();
    expect(store.getState().merge).toBeNull();
    expect(hidden).toEqual(['merge-people']);
  });
});

describe('the list of people who may be one', () => {
  it('reads the pairs, merges one keeping either person, and comes back to the list', async () => {
    const { store, commands, shown, hidden, settle } = setUp();
    commands.findDuplicates();
    await vi.waitFor(() => expect(store.getState().duplicates.kind).toBe('ready'));
    const list = store.getState().duplicates;
    const pair = list.kind === 'ready' ? list.pairs[0]! : null;
    expect([pair?.left.path, pair?.right.path]).toEqual(['Mara.md', 'People/Mara Quill.md']);

    commands.mergePair(pair!.key);
    await settle();
    const first = store.getState().merge;
    expect(first?.kind === 'previewed' && first.preview.keep).toBe('Mara.md');
    commands.swap();
    await settle();
    const swapped = store.getState().merge;
    expect(swapped?.kind === 'previewed' && [swapped.preview.keep, swapped.preview.merge]).toEqual([
      'People/Mara Quill.md',
      ['Mara.md'],
    ]);
    commands.closeMerge();
    expect(shown).toEqual(['people-duplicates', 'merge-people', 'people-duplicates']);
    expect(hidden).toEqual(['people-duplicates', 'merge-people']);
  });

  it('leaves out a pair said not to be one at once, and remembers it in the settings', async () => {
    const { store, commands, written } = setUp();
    commands.findDuplicates();
    await vi.waitFor(() => expect(store.getState().duplicates.kind).toBe('ready'));
    const list = store.getState().duplicates;
    const key = list.kind === 'ready' ? list.pairs[0]!.key : '';
    commands.dismiss(key);
    expect(store.getState().duplicates).toEqual({ kind: 'ready', pairs: [] });
    await vi.waitFor(() =>
      expect(written).toEqual([{ notDuplicatePeople: [['Mara.md', 'People/Mara Quill.md']] }]),
    );
  });

  it('says so when the pair could not be remembered', async () => {
    const { store, commands } = setUp({ failSettings: true });
    commands.findDuplicates();
    await vi.waitFor(() => expect(store.getState().duplicates.kind).toBe('ready'));
    const list = store.getState().duplicates;
    commands.dismiss(list.kind === 'ready' ? list.pairs[0]!.key : '');
    await vi.waitFor(() =>
      expect(store.getState().duplicates).toEqual({
        kind: 'failed',
        message: 'Not remembered: The settings note is read-only.',
      }),
    );
  });
});

describe('merging people chosen in a table (#467)', () => {
  it('asks who to merge every chosen person into, leaving them out of the choices, then merges them all', async () => {
    const { store, commands, settle } = setUp();
    commands.mergeMany([p('Mara.md'), p('Tobias Fenn.md')]);
    await vi.waitFor(() => expect(store.getState().merge?.kind).toBe('picking'));
    const picking = store.getState().merge;
    expect(picking?.kind === 'picking' && picking.choices.map((choice) => choice.path)).toEqual([
      'People/Mara Quill.md',
    ]);
    commands.pick('People/Mara Quill.md');
    await settle();
    const flow = store.getState().merge;
    expect(flow?.kind === 'previewed' && flow.preview.merge).toEqual(['Mara.md', 'Tobias Fenn.md']);
  });

  it('merges the people the focused tab’s table has chosen from ⌘K, or says none are', async () => {
    const { store, commands, shown } = setUp();
    commands.mergeChosen('tab-1');
    expect(store.getState().merge).toEqual({
      kind: 'refused',
      message:
        'No people are selected. Tick the people to merge in the Person table, or a People view with Select on, then try again.',
    });
    commands.noteChosen('tab-1', { paths: [p('Mara.md')], settled: () => {} });
    // Another tab's table letting go leaves this tab's choice as it is.
    commands.noteChosen('tab-2', null);
    commands.mergeChosen('tab-2');
    expect(store.getState().merge?.kind).toBe('refused');
    commands.mergeChosen('tab-1');
    await vi.waitFor(() => expect(store.getState().merge?.kind).toBe('picking'));
    const picking = store.getState().merge;
    expect(picking?.kind === 'picking' && picking.subjects).toEqual(['Mara.md']);
    expect(shown).toEqual(['merge-people', 'merge-people', 'merge-people']);
  });

  it('tells the table its rows were answered once the merge is made, choosing again any still in the vault', async () => {
    const { vault, store, commands, settle } = setUp();
    const answers: unknown[] = [];
    commands.mergeMany([p('Mara.md'), p('Tobias Fenn.md')], (answer) => answers.push(answer));
    await vi.waitFor(() => expect(store.getState().merge?.kind).toBe('picking'));
    commands.pick('People/Mara Quill.md');
    await settle();
    commands.confirm();
    await vi.waitFor(() => expect(store.getState().merge).toBeNull());
    expect(vault.trashed).toEqual(['Mara.md', 'Tobias Fenn.md']);
    expect(answers).toEqual([{ answered: ['Mara.md', 'Tobias Fenn.md'], failed: [] }]);
  });

  it('tells the table nothing when the merge is closed unmade', async () => {
    const { store, commands } = setUp();
    const answers: unknown[] = [];
    commands.mergeMany([p('Mara.md')], (answer) => answers.push(answer));
    await vi.waitFor(() => expect(store.getState().merge?.kind).toBe('picking'));
    commands.closeMerge();
    expect(answers).toEqual([]);
  });
});
