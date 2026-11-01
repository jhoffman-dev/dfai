// @vitest-environment jsdom
/**
 * Make task, said in the window's toast (UI v2, slice 15): the task made is
 * said with Open and one Undo that takes back the task and the line — a real
 * write of the bytes the note held, refused once either has moved on — said
 * as a warning toast — and nothing at all once another vault has opened. A
 * line that could not become a task is said on the page.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import { fakeVaultFs, recordingActivity, type OpenNotes } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { createToasts } from '../toasts/toasts.ts';
import { useLinePromotion } from './use-line-promotion.ts';

const PLAN = createVaultPath('plans/Plan the launch.md');
const TEXT = '# Plan the launch\n\n- [ ] Order chairs\n- [ ] Ring Mara Quill\n';

/** A vault in memory whose writes are checked against the version read, as the host checks them. */
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

function promoting() {
  const vault = memoryVault();
  const toasts = createToasts();
  toasts.openVault('Larkspur');
  const onOpenNote = vi.fn();
  const onChanged = vi.fn();
  const openNotes = {
    state: () => 'closed',
    setPropertiesIfOpen: async () => false,
    reload: () => {},
  } as unknown as OpenNotes;
  const hook = renderHook(() =>
    useLinePromotion({
      fs: vault.fs,
      markdown: remarkMarkdown,
      openNotes,
      flush: async () => {},
      path: PLAN,
      notePaths: [PLAN],
      types: [],
      onChanged,
      onOpenNote,
      activity: recordingActivity(),
      toasts,
    }),
  );
  const shown = () => toasts.store.getState().toasts;
  const promote = async () => {
    await act(() => hook.result.current?.promote({ index: 0, text: 'Order chairs' }));
    await waitFor(() => expect(shown()).toHaveLength(1));
    const [toast] = shown();
    const task = [...vault.files.keys()].find((path) => path.endsWith('/Order chairs.md'));
    return { toast: toast!, task: task! };
  };
  return { ...vault, toasts, hook, shown, promote, onOpenNote, onChanged };
}

describe('Make task, said in a toast', () => {
  it('says the task made, with Open and an Undo, and nothing on the page', async () => {
    const { hook, promote, onOpenNote } = promoting();
    const { toast, task } = await promote();

    expect(toast).toMatchObject({ message: '“Order chairs” is a task now.', tone: 'change' });
    expect(toast.onUndo).toBeTypeOf('function');
    expect(toast.action?.label).toBe('Open');
    expect(hook.result.current?.notice).toBeNull();

    toast.action?.onClick();
    expect(onOpenNote).toHaveBeenCalledWith(task);
  });

  it('takes back the task and the line with one Undo, byte for byte', async () => {
    const { files, promote, onChanged } = promoting();
    const { toast, task } = await promote();
    expect(files.get(PLAN)?.text).not.toBe(TEXT);
    onChanged.mockClear();

    await act(async () => toast.onUndo?.());

    await waitFor(() => expect(files.get(PLAN)?.text).toBe(TEXT));
    expect(files.has(task)).toBe(false);
    expect(onChanged).toHaveBeenCalled();
  });

  it('refuses the Undo once the note has moved on, and says why in a warning toast', async () => {
    const { files, edit, hook, promote, shown } = promoting();
    const { toast, task } = await promote();
    const later = `${files.get(PLAN)?.text ?? ''}A line typed elsewhere.\n`;
    edit(PLAN, later);

    await act(async () => toast.onUndo?.());

    // Said where the person is — the toast — and not on a page they may have left.
    await waitFor(() => expect(shown().at(-1)).toMatchObject({ tone: 'warning' }));
    expect(shown().at(-1)?.message).toMatch(/changed/i);
    expect(hook.result.current?.notice).toBeNull();
    expect(files.get(PLAN)?.text).toBe(later);
    expect(files.has(task)).toBe(true);
  });

  it('writes nothing for an Undo pressed once another vault has opened', async () => {
    const { files, toasts, promote } = promoting();
    const { toast, task } = await promote();
    const promoted = files.get(PLAN)?.text;

    toasts.openVault('Elsewhere');
    await act(async () => toast.onUndo?.());

    expect(files.get(PLAN)?.text).toBe(promoted);
    expect(files.has(task)).toBe(true);
  });
});
