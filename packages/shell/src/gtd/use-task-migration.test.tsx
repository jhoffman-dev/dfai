// @vitest-environment jsdom
/**
 * P30-02: the Inbox's move to GTD, through the real markdown writer — read
 * only while the Inbox shows, run only from the preview, and every run and
 * undo said in Activity.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import {
  fakeIndexPort,
  fakeVaultFs,
  memoryVault,
  recordingActivity,
  type ArchivePorts,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useTaskMigration } from './use-task-migration.ts';

const FILES: Record<string, string> = {
  '.atlas/types/task.md':
    '---\nname: task\nproperties:\n  status:\n    kind: select\n    options: [backlog, doing, done]\n---\n\n# Task\n',
  'tasks/Draft the memo.md': '---\ntype: task\nstatus: doing\n---\n\nWords.\n',
  'tasks/Ship it.md': '---\ntype: task\nstatus: done\n---\n',
};

function setup({
  open = true,
  files = FILES,
}: { open?: boolean; files?: Record<string, string> } = {}) {
  const memory = memoryVault(files);
  const fs = fakeVaultFs({
    ...memory.fs,
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const text = memory.files.get(path);
        return text === undefined ? [] : [{ path, text, modified: 0, size: text.length }];
      }),
  });
  const index = fakeIndexPort({
    notesOfType: async () =>
      ['tasks/Draft the memo.md', 'tasks/Ship it.md'].map((path) => ({ path, title: path })),
  });
  const ports = {
    fs,
    markdown: remarkMarkdown,
    index,
    editors: {
      state: () => 'closed',
      reload: () => {},
      flush: async () => {},
      follow: () => {},
      abandon: () => {},
    },
  } as unknown as ArchivePorts;
  const activity = recordingActivity();
  const onChanged = vi.fn();
  const hook = renderHook(
    (props: { open: boolean }) =>
      useTaskMigration({
        ports,
        vaultKey: '/vault',
        indexReady: true,
        open: props.open,
        activity,
        onChanged,
      }),
    { initialProps: { open } },
  );
  return { files: memory.files, hook, activity, onChanged };
}

describe('useTaskMigration', () => {
  // Since #130 the preview is read as soon as the index is ready, so the Inbox opens on it.
  it('reads the preview before the Inbox shows, and has it ready as it opens', async () => {
    const { hook } = setup({ open: false });
    await waitFor(() => expect(hook.result.current?.preview?.tasks).toHaveLength(2));
    hook.rerender({ open: true });
    expect(hook.result.current?.reading).toBe(false);
    expect(hook.result.current?.preview?.tasks).toHaveLength(2);
  });

  it('moves the tasks from the preview, says so in Activity, and undoes it byte for byte', async () => {
    const { hook, files, activity, onChanged } = setup();
    await waitFor(() => expect(hook.result.current?.preview?.tasks).toHaveLength(2));
    act(() => hook.result.current?.onOpen());
    act(() => hook.result.current?.onRun());
    await waitFor(() => expect(hook.result.current?.canUndo).toBe(true));
    expect(files.get('tasks/Ship it.md')).toContain('status: archive');
    expect(onChanged).toHaveBeenCalled();
    expect(activity.reports.at(-1)?.message).toMatch(/^Moved tasks to GTD statuses/);
    expect(hook.result.current?.result).toMatch(/^Moved tasks to GTD statuses/);

    act(() => hook.result.current?.onUndo());
    await waitFor(() => expect(hook.result.current?.canUndo).toBe(false));
    for (const [path, text] of Object.entries(FILES))
      expect(files.get(createVaultPath(path))).toBe(text);
    expect(activity.reports.at(-1)?.message).toMatch(/^Undid the move to GTD/);
  });

  it('runs with the person’s own choice for an old status', async () => {
    const { hook, files } = setup();
    await waitFor(() => expect(hook.result.current?.preview?.tasks).toHaveLength(2));
    act(() => hook.result.current?.onChoose({ from: 'doing', to: 'someday' }));
    await waitFor(() =>
      expect(hook.result.current?.preview?.tasks.find((task) => task.from === 'doing')?.to).toBe(
        'someday',
      ),
    );
    act(() => hook.result.current?.onRun());
    await waitFor(() => expect(hook.result.current?.canUndo).toBe(true));
    expect(files.get('tasks/Draft the memo.md')).toBe(
      '---\ntype: task\nstatus: someday\n---\n\nWords.\n',
    );
  });
});

describe('useTaskMigration — the undo is offered once (#163)', () => {
  afterEach(() => vi.useRealTimers());

  /** Runs the move, then closes the app: what the vault holds is what the next launch reads. */
  async function movedThenClosed(): Promise<Record<string, string>> {
    const first = setup();
    await waitFor(() => expect(first.hook.result.current?.preview?.tasks).toHaveLength(2));
    act(() => first.hook.result.current?.onRun());
    await waitFor(() => expect(first.hook.result.current?.canUndo).toBe(true));
    first.hook.unmount();
    return Object.fromEntries(first.files);
  }

  /** The next launch, once everything it reads at start has been read. */
  async function relaunched(files: Record<string, string>) {
    const next = setup({ files });
    await act(() => new Promise((settle) => setTimeout(settle, 20)));
    return next.hook.result.current;
  }

  it('still offers the undo after a restart within the week', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 8, 9, 30));
    const files = await movedThenClosed();

    vi.setSystemTime(new Date(2026, 9, 14, 18, 0));
    expect((await relaunched(files))?.canUndo).toBe(true);
  });

  it('stops offering the undo a week after the move, and does not offer it again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 8, 9, 30));
    const files = await movedThenClosed();

    vi.setSystemTime(new Date(2026, 9, 15, 9, 30));
    expect(await relaunched(files)).toBeNull();
  });

  it('stops offering the undo once dismissed, and it stays gone after a restart', async () => {
    const { hook, files } = setup();
    await waitFor(() => expect(hook.result.current?.preview?.tasks).toHaveLength(2));
    act(() => hook.result.current?.onRun());
    await waitFor(() => expect(hook.result.current?.canUndo).toBe(true));

    act(() => hook.result.current?.onDismiss());
    await waitFor(() => expect(hook.result.current).toBeNull());
    hook.unmount();

    expect(await relaunched(Object.fromEntries(files))).toBeNull();
  });
});

describe('useTaskMigration — while its preview is read (#130)', () => {
  it('says it is still reading until the preview is back, so the Inbox can hold its rows', async () => {
    const { hook } = setup();
    expect(hook.result.current?.reading).toBe(true);
    expect(hook.result.current?.preview).toBeNull();
    await waitFor(() => expect(hook.result.current?.preview?.tasks).toHaveLength(2));
    expect(hook.result.current?.reading).toBe(false);
  });

  it('is never reading while the Inbox is not showing', async () => {
    const { hook } = setup({ open: false });
    expect(hook.result.current?.reading ?? false).toBe(false);
    await waitFor(() => expect(hook.result.current?.preview?.tasks).toHaveLength(2));
    expect(hook.result.current?.reading).toBe(false);
  });
});
