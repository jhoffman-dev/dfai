// @vitest-environment jsdom
/**
 * P31-01: a vault whose tasks follow GTD is given the Block type through the
 * real markdown writer — as it opens, or as soon as its tasks move to GTD —
 * and Activity says so.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { fakeVaultFs, memoryVault, recordingActivity, type VaultFsPort } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { GTD_STATUS_PROPERTY, type ObjectType } from '@dfai/domain';
import { useBlockType } from './use-block-type.ts';

const TASK = [
  '---',
  'name: task',
  'label: Task',
  'properties:',
  '  status:',
  '    kind: select',
  '    options: [inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
  '    done: archive',
  '  estimate: number',
  '---',
  '',
  '# Task',
  '',
].join('\n');

/** The types as the app read them: a GTD Task type, or one on statuses of its own. */
const GTD_TYPES: readonly ObjectType[] = [
  { name: 'task', label: 'Task', properties: [GTD_STATUS_PROPERTY] },
];
const OWN_TYPES: readonly ObjectType[] = [
  {
    name: 'task',
    label: 'Task',
    properties: [{ ...GTD_STATUS_PROPERTY, options: ['backlog', 'done'], done: 'done' }],
  },
];

function setup(
  files: Record<string, string>,
  {
    types = GTD_TYPES,
    createNote,
    readNotes,
  }: {
    types?: readonly ObjectType[];
    createNote?: () => Promise<number>;
    readNotes?: VaultFsPort['readNotes'];
  } = {},
) {
  const memory = memoryVault(files);
  const listed = vi.fn(memory.fs.listDirectory);
  const fs = fakeVaultFs({
    ...memory.fs,
    listDirectory: listed,
    ...(createNote !== undefined && { createNote }),
    readNotes:
      readNotes ??
      (async (paths) =>
        paths.flatMap((path) => {
          const text = memory.files.get(path);
          return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
        })),
  });
  const onChanged = vi.fn();
  const activity = recordingActivity();
  const hook = renderHook(
    ({ known }: { known: readonly ObjectType[] }) =>
      useBlockType({
        fs,
        markdown: remarkMarkdown,
        vaultKey: '/vault',
        types: known,
        activity,
        onChanged,
      }),
    { initialProps: { known: types } },
  );
  return { files: memory.files, onChanged, activity, hook, listed };
}

describe('useBlockType', () => {
  it('writes the Block type into a vault whose tasks follow GTD, says so, and says the vault changed', async () => {
    const { files, onChanged, activity } = setup({ '.atlas/types/task.md': TASK });

    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());

    expect(files.get('.atlas/types/block.md')).toBe(
      [
        '---',
        'name: block',
        'label: Block',
        'icon: calendar',
        'properties:',
        '  start:',
        '    kind: date',
        '    required: true',
        '  end:',
        '    kind: date',
        '    required: true',
        '  tasks:',
        '    kind: relation',
        '    target: task',
        '    many: true',
        '  gcal_event_id:',
        '    kind: text',
        '    label: Google event',
        '  gcal_etag:',
        '    kind: text',
        '    label: Google version',
        '  gcal_calendar:',
        '    kind: text',
        '    label: Google calendar',
        '  gcal_missing:',
        '    kind: checkbox',
        '    label: Deleted in Google',
        '---',
        '',
        '# Block',
        '',
        'Time set aside on the calendar, from its start to its end, for the tasks it links.',
        'A block holding one task gives that task all of its time; a block holding several',
        'shares its time among them by what each has left of its estimate.',
        '',
      ].join('\n'),
    );
    expect(files.get('.atlas/types/task.md')).toBe(TASK);
    expect(
      activity.reports.map(({ level, message, subject }) => [level, message, subject]),
    ).toEqual([
      [
        'info',
        'Added the Block type: this vault’s tasks follow GTD, and timeblocks schedule them.',
        { kind: 'note', path: '.atlas/types/block.md' },
      ],
    ]);
  });

  it('writes nothing, and says nothing, in a vault without tasks', async () => {
    const { files, onChanged, activity, listed } = setup(
      { 'Notes.md': '# Notes\n' },
      { types: [] },
    );
    // Give a read of the types a turn to finish before looking.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...files.keys()]).toEqual(['Notes.md']);
    expect(onChanged).not.toHaveBeenCalled();
    expect(activity.reports).toEqual([]);
    // The types the app already read say there is nothing to write, so the files are not read again.
    expect(listed).not.toHaveBeenCalled();
  });

  it('waits for a vault on statuses of its own, and writes it once its tasks move to GTD', async () => {
    const own = TASK.replace(
      '[inbox, backlog, next-action, in-progress, waiting, someday, longterm, archive]',
      '[backlog, done]',
    ).replace('done: archive', 'done: done');
    const { files, onChanged, hook } = setup({ '.atlas/types/task.md': own }, { types: OWN_TYPES });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(files.has('.atlas/types/block.md')).toBe(false);

    // The move to GTD rewrites the Task type, and the app reads its types again.
    files.set('.atlas/types/task.md', TASK);
    hook.rerender({ known: GTD_TYPES });

    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(files.has('.atlas/types/block.md')).toBe(true);
  });

  it('records in Activity why the type could not be written', async () => {
    const { activity, onChanged } = setup(
      { '.atlas/types/task.md': TASK },
      { createNote: async () => Promise.reject(new Error('the disk is full')) },
    );
    await waitFor(() =>
      expect(activity.reports.map(({ level, message }) => [level, message])).toEqual([
        ['warning', 'The Block type could not be added: the disk is full'],
      ]),
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('says nothing in another vault’s Activity about a write that lands after the switch', async () => {
    const memory = memoryVault({ '.atlas/types/task.md': TASK });
    const writes: (() => void)[] = [];
    const fs = fakeVaultFs({
      ...memory.fs,
      readNotes: async (paths) =>
        paths.flatMap((path) => {
          const text = memory.files.get(path);
          return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
        }),
      createNote: (args) =>
        new Promise<number>((resolve, reject) => {
          writes.push(() => memory.fs.createNote(args).then(resolve, reject));
        }),
    });
    const onChanged = vi.fn();
    const activity = recordingActivity();
    const hook = renderHook(
      ({ vault, known }: { vault: string; known: readonly ObjectType[] }) =>
        useBlockType({
          fs,
          markdown: remarkMarkdown,
          vaultKey: vault,
          types: known,
          activity,
          onChanged,
        }),
      { initialProps: { vault: '/vault', known: GTD_TYPES } },
    );
    await waitFor(() => expect(writes).toHaveLength(1));

    hook.rerender({ vault: '/other', known: [] });
    for (const write of writes) write();
    await waitFor(() => expect(memory.files.has('.atlas/types/block.md')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(activity.reports).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('waits for every write it started before warning: one that fails first is no failure if another lands', async () => {
    const memory = memoryVault({ '.atlas/types/task.md': TASK });
    const writes: { land: () => void; refuse: (reason: string) => void }[] = [];
    const fs = fakeVaultFs({
      ...memory.fs,
      readNotes: async (paths) =>
        paths.flatMap((path) => {
          const text = memory.files.get(path);
          return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
        }),
      createNote: (args) =>
        new Promise<number>((resolve, reject) => {
          writes.push({
            land: () => void memory.fs.createNote(args).then(resolve, reject),
            refuse: (reason) => reject(new Error(reason)),
          });
        }),
    });
    const onChanged = vi.fn();
    const activity = recordingActivity();
    const hook = renderHook(
      ({ known }: { known: readonly ObjectType[] }) =>
        useBlockType({
          fs,
          markdown: remarkMarkdown,
          vaultKey: '/vault',
          types: known,
          activity,
          onChanged,
        }),
      { initialProps: { known: GTD_TYPES } },
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    hook.rerender({ known: [...GTD_TYPES] });
    await waitFor(() => expect(writes).toHaveLength(2));

    writes[0]?.refuse('the disk is busy');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activity.reports).toEqual([]);
    writes[1]?.land();

    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(activity.reports.map(({ level, message }) => [level, message])).toEqual([
      [
        'info',
        'Added the Block type: this vault’s tasks follow GTD, and timeblocks schedule them.',
      ],
    ]);
  });

  it('says why when the vault’s types cannot be read, without paths on this Mac', async () => {
    const { activity } = setup(
      { '.atlas/types/task.md': TASK },
      {
        readNotes: async () =>
          Promise.reject(new Error('could not read /Users/mara/Vault/.atlas/types/task.md')),
      },
    );
    await waitFor(() => expect(activity.reports).toHaveLength(1));
    expect(activity.reports[0]?.level).toBe('warning');
    expect(activity.reports[0]?.message).toMatch(/^The Block type could not be added: /);
    expect(activity.reports[0]?.message).not.toContain('/Users/mara');
  });

  it('warns nothing in another vault about a write that fails after the switch', async () => {
    const memory = memoryVault({ '.atlas/types/task.md': TASK });
    const refusals: (() => void)[] = [];
    const fs = fakeVaultFs({
      ...memory.fs,
      readNotes: async (paths) =>
        paths.flatMap((path) => {
          const text = memory.files.get(path);
          return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
        }),
      createNote: () =>
        new Promise<number>((_, reject) => {
          refusals.push(() => reject(new Error('the disk is full')));
        }),
    });
    const activity = recordingActivity();
    const hook = renderHook(
      ({ vault, known }: { vault: string; known: readonly ObjectType[] }) =>
        useBlockType({
          fs,
          markdown: remarkMarkdown,
          vaultKey: vault,
          types: known,
          activity,
          onChanged: vi.fn(),
        }),
      { initialProps: { vault: '/vault', known: GTD_TYPES } },
    );
    await waitFor(() => expect(refusals).toHaveLength(1));

    hook.rerender({ vault: '/other', known: [] });
    refusals[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(activity.reports).toEqual([]);
  });
});
