// @vitest-environment jsdom
/**
 * The type editor's decisions, against an in-memory vault written through the
 * real markdown adapter: a change is saved at once unless it touches notes,
 * one that does is asked about with a count, and the answer decides whether
 * the notes are rewritten.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, parseObjectType, splitFrontmatter } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, type DefinedType } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useTypeEditor } from './use-type-editor.ts';

const TYPE_PATH = '.atlas/types/task.md';
const TYPE_FILE = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [backlog, review, done]',
  '  phase: text',
  '---',
  '',
  '# Task',
  '',
].join('\n');

const note = (status: string, phase = '1') =>
  ['---', 'type: task', `status: ${status}`, `phase: ${phase}`, '---', '', 'Body.', ''].join('\n');

function setUp({ failWrite = null }: { failWrite?: string | null } = {}) {
  const files = new Map<string, string>([
    [TYPE_PATH, TYPE_FILE],
    ['a.md', note('review')],
    ['b.md', note('review', 'soon')],
    ['c.md', note('done')],
  ]);
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({ text: files.get(path) ?? '', modified: 1 }),
    readNotes: async (paths) =>
      paths.map((path) => ({ path, text: files.get(path) ?? '', modified: 1, size: 1 })),
    writeTextFile: async ({ path, contents }) => {
      if (path === failWrite) throw new Error('the note changed on disk');
      files.set(path, contents);
      return 2;
    },
  });
  const index = fakeIndexPort({
    notesOfType: async () => ['a.md', 'b.md', 'c.md'].map((path) => ({ path, title: path })),
  });
  const { frontmatter } = splitFrontmatter(TYPE_FILE);
  const type: DefinedType = {
    ...parseObjectType(remarkMarkdown.frontmatterProperties(frontmatter)),
    path: createVaultPath(TYPE_PATH),
  };
  const onSaved = vi.fn(async (): Promise<readonly DefinedType[] | null> => null);
  const openNotes = { setPropertiesIfOpen: async () => false };
  const hook = renderHook(
    ({ shown }: { shown: DefinedType }) =>
      useTypeEditor({
        fs,
        markdown: remarkMarkdown,
        index,
        openNotes,
        type: shown,
        types: [type],
        onSaved,
      }),
    { initialProps: { shown: type } },
  );
  const typeOnDisk = () =>
    parseObjectType(
      remarkMarkdown.frontmatterProperties(
        splitFrontmatter(files.get(TYPE_PATH) ?? '').frontmatter,
      ),
    );
  return { hook, files, onSaved, typeOnDisk, type };
}

const status = (text: string | undefined) => /status: (.*)/.exec(text ?? '')?.[1];

describe('useTypeEditor', () => {
  it('saves a change that touches no note at once', async () => {
    const { hook, onSaved, typeOnDisk, files } = setUp();
    act(() => hook.result.current.edit({ kind: 'setLabel', label: 'Chore' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(typeOnDisk().label).toBe('Chore');
    expect(hook.result.current.prompt).toBeNull();
    // The body of the type file is kept.
    expect(files.get(TYPE_PATH)?.endsWith('\n# Task\n')).toBe(true);
  });

  it('asks before renaming an option notes use, with how many', async () => {
    const { hook, files } = setUp();
    act(() =>
      hook.result.current.edit({
        kind: 'renameOption',
        key: 'status',
        from: 'review',
        to: 'in review',
      }),
    );
    await waitFor(() => expect(hook.result.current.prompt).not.toBeNull());
    expect(hook.result.current.prompt?.text).toBe(
      '2 notes use “review”. Change them to “in review”?',
    );
    expect(hook.result.current.prompt?.actions.map((action) => action.label)).toEqual([
      'Rename and update 2 notes',
      'Rename only',
      'Cancel',
    ]);
    // Nothing is written while the question is open.
    expect(files.get(TYPE_PATH)).toBe(TYPE_FILE);
  });

  it('renames the option and every note using it, and says so', async () => {
    const { hook, files, typeOnDisk } = setUp();
    act(() =>
      hook.result.current.edit({
        kind: 'renameOption',
        key: 'status',
        from: 'review',
        to: 'in review',
      }),
    );
    await waitFor(() => expect(hook.result.current.prompt).not.toBeNull());
    act(() => hook.result.current.prompt?.actions[0]?.run());
    await waitFor(() => expect(hook.result.current.notice?.text).toBe('Updated 2 notes.'));
    expect(typeOnDisk().properties[0]?.options).toEqual(['backlog', 'in review', 'done']);
    expect([
      status(files.get('a.md')),
      status(files.get('b.md')),
      status(files.get('c.md')),
    ]).toEqual(['in review', 'in review', 'done']);
    expect(files.get('b.md')).toContain('phase: soon');
  });

  it('renames only the option when asked to leave the notes', async () => {
    const { hook, files, typeOnDisk, onSaved } = setUp();
    act(() =>
      hook.result.current.edit({
        kind: 'renameOption',
        key: 'status',
        from: 'review',
        to: 'in review',
      }),
    );
    await waitFor(() => expect(hook.result.current.prompt).not.toBeNull());
    act(() => hook.result.current.prompt?.actions[1]?.run());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(typeOnDisk().properties[0]?.options).toContain('in review');
    expect(status(files.get('a.md'))).toBe('review');
  });

  it('changes nothing when cancelled', async () => {
    const { hook, files, onSaved } = setUp();
    act(() => hook.result.current.edit({ kind: 'removeProperty', key: 'phase' }));
    await waitFor(() => expect(hook.result.current.prompt).not.toBeNull());
    expect(hook.result.current.prompt?.text).toBe(
      '3 notes have a value for Phase. Take it out of them too?',
    );
    act(() => hook.result.current.prompt?.actions.at(-1)?.run());
    expect(hook.result.current.prompt).toBeNull();
    expect(files.get(TYPE_PATH)).toBe(TYPE_FILE);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('does not ask when no note holds what changed', async () => {
    const { hook, onSaved, typeOnDisk } = setUp();
    act(() =>
      hook.result.current.edit({
        kind: 'renameOption',
        key: 'status',
        from: 'backlog',
        to: 'todo',
      }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(hook.result.current.prompt).toBeNull();
    expect(typeOnDisk().properties[0]?.options[0]).toBe('todo');
  });

  it('warns before a kind change leaves values that will not fit', async () => {
    const { hook, typeOnDisk, onSaved } = setUp();
    act(() =>
      hook.result.current.edit({ kind: 'changeKind', key: 'phase', propertyKind: 'number' }),
    );
    await waitFor(() => expect(hook.result.current.prompt).not.toBeNull());
    expect(hook.result.current.prompt?.text).toMatch(/^1 note holds a value that won't fit/);
    act(() => hook.result.current.prompt?.actions[0]?.run());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(typeOnDisk().properties[1]?.kind).toBe('number');
  });

  it('makes a select that allows many a multi-select, counting the values first', async () => {
    const { hook, typeOnDisk, onSaved } = setUp();
    act(() => hook.result.current.edit({ kind: 'setMany', key: 'status', many: true }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // Every note holds one status, which a multi-select holds as well: nothing to ask.
    expect(hook.result.current.prompt).toBeNull();
    expect(typeOnDisk().properties[0]).toMatchObject({
      kind: 'multiSelect',
      options: ['backlog', 'review', 'done'],
    });
  });

  it('shows why a change was refused, and writes nothing', async () => {
    const { hook, files } = setUp();
    act(() => hook.result.current.edit({ kind: 'addOption', key: 'status', option: 'done' }));
    await waitFor(() =>
      expect(hook.result.current.notice).toEqual({
        tone: 'problem',
        text: 'Status already has "done"',
      }),
    );
    expect(files.get(TYPE_PATH)).toBe(TYPE_FILE);
  });

  it('carries out quick changes in order, each on top of the one before', async () => {
    // Found in e2e: a key renamed and its kind changed a moment later lost the
    // rename, because both were worked out from the type before either landed.
    const { hook, typeOnDisk, onSaved } = setUp();
    act(() => {
      hook.result.current.edit({ kind: 'addProperty', label: 'Property' });
      hook.result.current.edit({
        kind: 'renameProperty',
        key: 'property',
        newKey: 'author',
        label: 'Author',
      });
      hook.result.current.edit({ kind: 'changeKind', key: 'author', propertyKind: 'relation' });
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(3));
    expect(typeOnDisk().properties.at(-1)).toMatchObject({
      key: 'author',
      label: 'Author',
      kind: 'relation',
      target: 'task',
    });
    expect(hook.result.current.notice).toBeNull();
  });

  it('keeps its changes over a re-read older than them, until its own re-read lands', async () => {
    // #456: a re-read begun before a kind change landed reached the editor
    // after it, with nothing pending, and the next pick ("Points at") was
    // worked out from it: "Author is not a relation", and the pick was lost.
    const { hook, typeOnDisk, onSaved, type } = setUp();
    const rereads: ((types: null) => void)[] = [];
    onSaved.mockImplementation(() => new Promise((resolve) => rereads.push(resolve)));
    act(() => {
      hook.result.current.edit({ kind: 'addProperty', label: 'Author' });
      hook.result.current.edit({ kind: 'changeKind', key: 'author', propertyKind: 'relation' });
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    // The type as read before either change, shown before the re-read the saves asked for.
    hook.rerender({ shown: { ...type } });
    expect(hook.result.current.draft?.properties.at(-1)?.kind).toBe('relation');
    act(() =>
      hook.result.current.edit({ kind: 'setRelation', key: 'author', target: 'task', many: true }),
    );
    // Saved, or refused with a notice: whichever, then said which.
    await waitFor(() =>
      expect(onSaved.mock.calls.length === 3 || hook.result.current.notice !== null).toBe(true),
    );
    expect(hook.result.current.notice).toBeNull();
    expect(typeOnDisk().properties.at(-1)).toMatchObject({
      key: 'author',
      kind: 'relation',
      target: 'task',
      many: true,
    });
    // Its own re-reads landed, what the file says is shown again.
    await act(async () => rereads.forEach((landed) => landed(null)));
    hook.rerender({ shown: { ...typeOnDisk(), path: type.path, label: 'Chore' } });
    expect(hook.result.current.draft?.label).toBe('Chore');
  });

  it('shows a change made outside while its own was pending, once its re-read lands', async () => {
    // Passed over while the label was on its way; the next answer is the same
    // types, which draws nothing new, so the re-read's own answer is shown.
    const { hook, files, onSaved, type } = setUp();
    let landed: (types: readonly DefinedType[]) => void = () => {};
    onSaved.mockImplementation(() => new Promise((resolve) => (landed = resolve)));
    act(() => hook.result.current.edit({ kind: 'setLabel', label: 'Chore' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    // Someone renames the type in another editor before the re-read lands.
    files.set(TYPE_PATH, (files.get(TYPE_PATH) ?? '').replace('label: Chore', 'label: Errand'));
    const outside = { ...type, label: 'Errand' };
    hook.rerender({ shown: outside });
    expect(hook.result.current.draft?.label).toBe('Chore');
    await act(async () => landed([outside]));
    expect(hook.result.current.draft?.label).toBe('Errand');
    act(() => hook.result.current.edit({ kind: 'setIcon', icon: 'grid' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(hook.result.current.draft).toMatchObject({ label: 'Errand', icon: 'grid' });
  });

  it('takes re-reads again once one it waited on has failed', async () => {
    const { hook, onSaved, type } = setUp();
    onSaved.mockImplementation(async () => {
      throw new Error('the types could not be read');
    });
    act(() => hook.result.current.edit({ kind: 'setLabel', label: 'Chore' }));
    await waitFor(() => expect(hook.result.current.draft?.label).toBe('Chore'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    // Nothing is pending once the failed read is over: the next re-read is shown.
    await act(async () => hook.rerender({ shown: { ...type, label: 'Errand' } }));
    expect(hook.result.current.draft?.label).toBe('Errand');
    expect(hook.result.current.notice).toBeNull();
  });

  it('reports each note it could not rewrite, and rewrites the rest', async () => {
    const { hook, files } = setUp({ failWrite: 'a.md' });
    act(() =>
      hook.result.current.edit({
        kind: 'renameOption',
        key: 'status',
        from: 'review',
        to: 'in review',
      }),
    );
    await waitFor(() => expect(hook.result.current.prompt).not.toBeNull());
    act(() => hook.result.current.prompt?.actions[0]?.run());
    await waitFor(() => expect(hook.result.current.notice?.tone).toBe('problem'));
    expect(hook.result.current.notice?.text).toBe('Updated 1 note; 1 note could not be updated.');
    expect(hook.result.current.notice?.details).toEqual(['a: the note changed on disk']);
    expect(status(files.get('b.md'))).toBe('in review');
  });
});

const PROJECT_PATH = '.atlas/types/project.md';
const PROJECT_FILE = [
  '---',
  'name: project',
  'label: Project',
  'properties:',
  '  owner: text',
  '  budget: number',
  '---',
  '',
  '# Project',
  '',
].join('\n');

/** Task and Project, with the writes to notes held until `release` is called. */
function setUpTwoTypes() {
  const files = new Map<string, string>([
    [TYPE_PATH, TYPE_FILE],
    [PROJECT_PATH, PROJECT_FILE],
    ['a.md', note('review')],
    ['b.md', note('review', 'soon')],
  ]);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({ text: files.get(path) ?? '', modified: 1 }),
    readNotes: async (paths) =>
      paths.map((path) => ({ path, text: files.get(path) ?? '', modified: 1, size: 1 })),
    writeTextFile: async ({ path, contents }) => {
      if (!path.startsWith('.atlas/')) await held;
      files.set(path, contents);
      return 2;
    },
  });
  const index = fakeIndexPort({
    notesOfType: async () => ['a.md', 'b.md'].map((path) => ({ path, title: path })),
  });
  const defined = (path: string): DefinedType => ({
    ...parseObjectType(
      remarkMarkdown.frontmatterProperties(splitFrontmatter(files.get(path) ?? '').frontmatter),
    ),
    path: createVaultPath(path),
  });
  const task = defined(TYPE_PATH);
  const project = defined(PROJECT_PATH);
  const onSaved = vi.fn(async (): Promise<readonly DefinedType[] | null> => null);
  const openNotes = { setPropertiesIfOpen: async () => false };
  const hook = renderHook(
    ({ type }: { type: DefinedType }) =>
      useTypeEditor({
        fs,
        markdown: remarkMarkdown,
        index,
        openNotes,
        type,
        types: [task, project],
        onSaved,
      }),
    { initialProps: { type: task } },
  );
  return { hook, files, project, release, defined };
}

describe('useTypeEditor, when another type is opened', () => {
  it('saves the next change to the type now open, not the one it left mid-migration', async () => {
    // Found in review: switching from Task to Project while Task's notes were
    // still being rewritten left Task in the editor, and the next change wrote
    // Task's properties into project.md.
    const { hook, files, project, release, defined } = setUpTwoTypes();
    act(() =>
      hook.result.current.edit({
        kind: 'renameOption',
        key: 'status',
        from: 'review',
        to: 'doing',
      }),
    );
    await waitFor(() => expect(hook.result.current.prompt).not.toBeNull());
    act(() => hook.result.current.prompt?.actions[0]?.run());
    await waitFor(() => expect(files.get(TYPE_PATH)).toContain('doing'));

    hook.rerender({ type: project });
    expect(hook.result.current.draft?.name).toBe('project');
    act(() => hook.result.current.edit({ kind: 'setLabel', label: 'Projects' }));
    release();

    await waitFor(() => expect(defined(PROJECT_PATH).label).toBe('Projects'));
    expect(defined(PROJECT_PATH).properties.map((property) => property.key)).toEqual([
      'owner',
      'budget',
    ]);
    expect(files.get(PROJECT_PATH)).not.toContain('status');
    await waitFor(() => expect(status(files.get('a.md'))).toBe('doing'));
    expect(defined(TYPE_PATH).label).toBe('Task');
  });

  it('refuses a change queued for the type it left, rather than applying it to the new one', async () => {
    const { hook, files, project, release, defined } = setUpTwoTypes();
    act(() =>
      hook.result.current.edit({
        kind: 'renameOption',
        key: 'status',
        from: 'review',
        to: 'doing',
      }),
    );
    await waitFor(() => expect(hook.result.current.prompt).not.toBeNull());
    act(() => hook.result.current.prompt?.actions[0]?.run());
    await waitFor(() => expect(files.get(TYPE_PATH)).toContain('doing'));
    // Queued behind Task's migration, then Project is opened before it runs.
    act(() => hook.result.current.edit({ kind: 'setLabel', label: 'Chore' }));
    hook.rerender({ type: project });
    release();

    await waitFor(() =>
      expect(hook.result.current.notice?.text).toBe(
        'That change was for Task, which is no longer open; it was not saved.',
      ),
    );
    expect(defined(TYPE_PATH).properties.map((property) => property.key)).toEqual([
      'status',
      'phase',
    ]);
    expect(files.get(PROJECT_PATH)).toBe(PROJECT_FILE);
  });

  it('cancels a question left open, so later changes are not stuck behind it', async () => {
    const { hook, files, project, defined } = setUpTwoTypes();
    act(() => hook.result.current.edit({ kind: 'removeProperty', key: 'phase' }));
    await waitFor(() => expect(hook.result.current.prompt).not.toBeNull());

    hook.rerender({ type: project });
    expect(hook.result.current.prompt).toBeNull();
    act(() => hook.result.current.edit({ kind: 'setLabel', label: 'Projects' }));

    await waitFor(() => expect(defined(PROJECT_PATH).label).toBe('Projects'));
    // The question left open was cancelled: Task is as it was.
    expect(files.get(TYPE_PATH)).toBe(TYPE_FILE);
  });
});

const BOOK_PATH = '.atlas/types/book.md';
// Written by hand, with parts the editor does not read: an icon it does not
// offer, a key inside a spec, a comment, a kind it does not know, and a
// relation with nothing to point at.
const BOOK_FILE = [
  '---',
  'name: book',
  'label: Book',
  'icon: rocket',
  'properties:',
  '  rating:',
  '    kind: number',
  '    hint: out of five # shown under the field',
  '  score: {kind: formula}',
  '  author: {kind: relation}',
  '---',
  '',
  '# Book',
  '',
].join('\n');

function setUpBook() {
  const files = new Map<string, string>([[BOOK_PATH, BOOK_FILE]]);
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({ text: files.get(path) ?? '', modified: 1 }),
    writeTextFile: async ({ path, contents }) => {
      files.set(path, contents);
      return 2;
    },
  });
  const type: DefinedType = {
    ...parseObjectType(
      remarkMarkdown.frontmatterProperties(splitFrontmatter(BOOK_FILE).frontmatter),
    ),
    path: createVaultPath(BOOK_PATH),
  };
  const onSaved = vi.fn(async (): Promise<readonly DefinedType[] | null> => null);
  const hook = renderHook(() =>
    useTypeEditor({
      fs,
      markdown: remarkMarkdown,
      index: fakeIndexPort(),
      openNotes: { setPropertiesIfOpen: async () => false },
      type,
      types: [type],
      onSaved,
    }),
  );
  return { hook, files, onSaved };
}

describe('useTypeEditor, on a type file written by hand', () => {
  it('changes only the label when the type is renamed', async () => {
    const { hook, files, onSaved } = setUpBook();
    act(() => hook.result.current.edit({ kind: 'setLabel', label: 'Books' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(files.get(BOOK_PATH)).toBe(BOOK_FILE.replace('label: Book', 'label: Books'));
  });

  it('keeps what it does not read inside a property it edits, and every other property', async () => {
    const { hook, files, onSaved } = setUpBook();
    act(() =>
      hook.result.current.edit({
        kind: 'renameProperty',
        key: 'rating',
        newKey: 'rating',
        label: 'Stars',
      }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(files.get(BOOK_PATH)).toBe(
      BOOK_FILE.replace(
        '    hint: out of five # shown under the field\n',
        '    hint: out of five # shown under the field\n    label: Stars\n',
      ),
    );
  });
});
