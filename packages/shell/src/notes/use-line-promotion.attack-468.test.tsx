// @vitest-environment jsdom
/**
 * Attack on PR #468 (UI v2 slice 15): Make task's Undo now lives in the
 * window's toast, which outlives the pane that made it. Its refusal, and
 * its vault, must still be the toast's — not a pane that is gone, or a
 * vault opened while the task was being made.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import { fakeVaultFs, recordingActivity, type OpenNotes } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { createToasts } from '../toasts/toasts.ts';
import { useLinePromotion } from './use-line-promotion.ts';

const PLAN = createVaultPath('plans/Plan the launch.md');
const OTHER = createVaultPath('plans/Other.md');
const TEXT = '# Plan the launch\n\n- [ ] Order chairs\n- [ ] Ring Mara Quill\n';

function memoryVault() {
  let clock = 100;
  const files = new Map([[PLAN as string, { text: TEXT, modified: clock }]]);
  const fs = fakeVaultFs({
    readTextFile: async (path) => {
      const file = files.get(path);
      if (file === undefined) throw new Error(`no such file: ${path}`);
      return { ...file };
    },
    writeTextFile: async ({ path, contents, expectedModified }) => {
      if (expectedModified !== null && files.get(path)?.modified !== expectedModified) {
        throw new Error('the note changed on disk since it was opened');
      }
      files.set(path, { text: contents, modified: (clock += 1) });
      return clock;
    },
    createNote: async ({ path, contents }) => {
      if (files.has(path)) throw new Error('a note with that name already exists');
      files.set(path, { text: contents, modified: (clock += 1) });
      return clock;
    },
    trashEntry: async ({ path }) => {
      if (!files.delete(path)) throw new Error(`no such entry: ${path}`);
    },
  });
  const edit = (path: string, text: string) => files.set(path, { text, modified: (clock += 1) });
  return { files, fs, edit };
}

const openNotes = {
  state: () => 'closed',
  setPropertiesIfOpen: async () => false,
  reload: () => {},
} as unknown as OpenNotes;

function promoting({ flush = async () => {} }: { flush?: () => Promise<void> } = {}) {
  const vault = memoryVault();
  const toasts = createToasts();
  toasts.openVault('Larkspur');
  const onOpenNote = vi.fn();
  const hook = renderHook(
    ({ path }: { path: VaultPath }) =>
      useLinePromotion({
        fs: vault.fs,
        markdown: remarkMarkdown,
        openNotes,
        flush,
        path,
        notePaths: [PLAN],
        types: [],
        onChanged: () => {},
        onOpenNote,
        activity: recordingActivity(),
        toasts,
      }),
    { initialProps: { path: PLAN } },
  );
  const shown = () => toasts.store.getState().toasts;
  return { ...vault, toasts, hook, shown, onOpenNote };
}

describe('Make task Undo from the toast (attack-468)', () => {
  it('says a refused Undo somewhere once the pane that made the task has closed', async () => {
    const { files, edit, hook, shown } = promoting();
    await act(() => hook.result.current?.promote({ index: 0, text: 'Order chairs' }));
    await waitFor(() => expect(shown()).toHaveLength(1));
    const [toast] = shown();
    // The peek (or the tab) the line was promoted in closes; the toast stays up.
    hook.unmount();
    edit(PLAN, `${files.get(PLAN)?.text ?? ''}A line typed elsewhere.\n`);

    await act(async () => toast?.onUndo?.());

    // The Undo was refused (the note moved on): the person must be told, and
    // with the pane gone the only place left to say it is the window's toasts.
    await waitFor(() => expect(shown().some((each) => /changed/i.test(each.message))).toBe(true));
  });

  it('says a refused Undo while the pane shows another note, not only on returning to the source', async () => {
    const { files, edit, hook, shown } = promoting();
    await act(() => hook.result.current?.promote({ index: 0, text: 'Order chairs' }));
    await waitFor(() => expect(shown()).toHaveLength(1));
    const [toast] = shown();
    hook.rerender({ path: OTHER });
    edit(PLAN, `${files.get(PLAN)?.text ?? ''}A line typed elsewhere.\n`);

    await act(async () => toast?.onUndo?.());

    await waitFor(() => {
      const onPage = hook.result.current?.notice?.message ?? '';
      const inToast = shown().some((each) => /changed/i.test(each.message));
      expect(/changed/i.test(onPage) || inToast).toBe(true);
    });
  });

  it('shows no Undo for a task whose making finished after another vault opened', async () => {
    let release: () => void = () => {};
    const flush = () => new Promise<void>((resolve) => (release = resolve));
    const { files, toasts, hook, shown } = promoting({ flush });
    let making: Promise<void> | undefined;
    act(() => {
      making = Promise.resolve(hook.result.current?.promote({ index: 0, text: 'Order chairs' }));
    });
    // Another vault opens while the pane's typing is still being written.
    toasts.openVault('Elsewhere');
    await act(async () => {
      release();
      await making;
    });
    await waitFor(() => expect(files.get(PLAN)?.text).not.toBe(TEXT));
    const promoted = files.get(PLAN)?.text;

    // Its toast, if any, must not offer an Undo that writes into a vault no longer open.
    for (const toast of shown()) await act(async () => toast.onUndo?.());
    expect(files.get(PLAN)?.text).toBe(promoted);
  });
});
