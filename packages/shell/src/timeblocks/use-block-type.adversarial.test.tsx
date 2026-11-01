// @vitest-environment jsdom
/**
 * P31-01, adversarial: the app reads its types again while the Block type is
 * still being written — another hook's write, a refresh — and hands the hook
 * an equal list it has not seen. The type is written once, and Activity says
 * it was added, not that it could not be.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { fakeVaultFs, memoryVault, recordingActivity } from '@dfai/application';
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

const gtdTypes = (): readonly ObjectType[] => [
  { name: 'task', label: 'Task', properties: [GTD_STATUS_PROPERTY] },
];

describe('useBlockType, while the types are read again', () => {
  it('says the Block type was added, and never that it could not be, when the types are read again mid-write', async () => {
    const memory = memoryVault({ '.atlas/types/task.md': TASK });
    // The host takes a moment to write, as an IPC round trip does.
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
      ({ known }: { known: readonly ObjectType[] }) =>
        useBlockType({
          fs,
          markdown: remarkMarkdown,
          vaultKey: '/vault',
          types: known,
          activity,
          onChanged,
        }),
      { initialProps: { known: gtdTypes() } },
    );
    await waitFor(() => expect(writes).toHaveLength(1));

    // The types are read again — equal, but a new list — before the write lands.
    hook.rerender({ known: gtdTypes() });
    await waitFor(() => expect(writes).toHaveLength(2));
    for (const write of writes) write();

    await waitFor(() => expect(activity.reports.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(memory.files.has('.atlas/types/block.md')).toBe(true);
    expect(activity.reports.map(({ level, message }) => [level, message])).toEqual([
      [
        'info',
        'Added the Block type: this vault’s tasks follow GTD, and timeblocks schedule them.',
      ],
    ]);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('warns once, not on every read of the types, about a Block type file it cannot write over', async () => {
    // A hand-edited block.md that no longer parses: the app's types leave it
    // out, and the host refuses to write over it.
    const memory = memoryVault({
      '.atlas/types/task.md': TASK,
      '.atlas/types/block.md': '---\nname: block\nproperties: [start\n---\n',
    });
    const fs = fakeVaultFs({
      ...memory.fs,
      readNotes: async (paths) =>
        paths.flatMap((path) => {
          const text = memory.files.get(path);
          return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
        }),
    });
    const activity = recordingActivity();
    const hook = renderHook(
      ({ known }: { known: readonly ObjectType[] }) =>
        useBlockType({
          fs,
          markdown: remarkMarkdown,
          vaultKey: '/vault',
          types: known,
          activity,
          onChanged: vi.fn(),
        }),
      { initialProps: { known: gtdTypes() } },
    );
    await waitFor(() => expect(activity.reports).toHaveLength(1));

    // The types arrive again as new arrays whenever they are read again (a
    // definition changed, or a vault reopened): three of them.
    for (let edit = 0; edit < 3; edit += 1) {
      hook.rerender({ known: gtdTypes() });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(activity.reports.filter(({ level }) => level === 'warning')).toHaveLength(1);
  });
});
