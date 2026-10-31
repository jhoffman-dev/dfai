// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import { fakeVaultFs, type NoteFile } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { useTypes } from './use-types.ts';

const typeFile = (label: string): NoteFile => ({
  path: '.atlas/types/task.md',
  text: `---\nname: task\nlabel: ${label}\n---\n`,
  modified: 1,
  size: 1,
});

describe('useTypes', () => {
  it('keeps the latest load when an older one finishes after it', async () => {
    // A save reloads the types, and so does the sync that finds the file
    // changed: two loads in flight, and the one that read the file before the
    // save can land last.
    const reads: ((files: NoteFile[]) => void)[] = [];
    const fs = fakeVaultFs({
      listDirectory: async () => [
        { kind: 'file', name: 'task.md', path: createVaultPath('.atlas/types/task.md') },
      ],
      readNotes: () => new Promise((resolve) => reads.push(resolve)),
    });
    const { client, wrapper } = queryWrapper();
    const hook = renderHook(() => useTypes({ fs, markdown: remarkMarkdown, vaultKey: '/vault' }), {
      wrapper,
    });
    await waitFor(() => expect(reads).toHaveLength(1));
    act(() => void hook.result.current.reload());
    await waitFor(() => expect(reads).toHaveLength(2));

    await act(async () => reads[1]?.([typeFile('After the save')]));
    await act(async () => reads[0]?.([typeFile('Before the save')]));
    // Settled: nothing still reading, and the answer drawn (the cache tells React a moment later).
    await waitFor(() => expect(client.isFetching()).toBe(0));
    await waitFor(() => expect(hook.result.current.types).toHaveLength(1));

    expect(hook.result.current.types.map((type) => type.label)).toEqual(['After the save']);
    expect(hook.result.current.types[0]?.path).toBe('.atlas/types/task.md');
  });

  it('settles a reload with what it read, or null when it failed or was given up', async () => {
    const reads: { resolve: (files: NoteFile[]) => void; reject: (cause: Error) => void }[] = [];
    const fs = fakeVaultFs({
      listDirectory: async () => [
        { kind: 'file', name: 'task.md', path: createVaultPath('.atlas/types/task.md') },
      ],
      readNotes: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    });
    const { wrapper } = queryWrapper();
    const hook = renderHook(() => useTypes({ fs, markdown: remarkMarkdown, vaultKey: '/vault' }), {
      wrapper,
    });
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => reads[0]?.resolve([typeFile('First')]));

    const read = hook.result.current.reload();
    await waitFor(() => expect(reads).toHaveLength(2));
    // Given up for a later reload: what the cache holds may be from before.
    const later = hook.result.current.reload();
    expect(await read).toBeNull();
    await waitFor(() => expect(reads).toHaveLength(3));
    await act(async () => reads[2]?.resolve([typeFile('After the save')]));
    expect((await later)?.map((type) => type.label)).toEqual(['After the save']);

    const failing = hook.result.current.reload();
    await waitFor(() => expect(reads).toHaveLength(4));
    await act(async () => reads[3]?.reject(new Error('the folder is gone')));
    expect(await failing).toBeNull();
  });
});
