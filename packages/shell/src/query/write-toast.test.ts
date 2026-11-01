import { describe, expect, it, vi } from 'vitest';
import { createVaultPath, type WriteRecord } from '@dfai/domain';
import { fakeVaultFs, memoryVault } from '@dfai/application';
import { createToasts } from '../toasts/toasts.ts';
import { sayWritten } from './write-toast.ts';

/** #320: a view's change said in a toast, whose Undo is a real, guarded write back. */
const PATH = createVaultPath('Tasks/Send the Larkspur invoice.md');
const BEFORE = '---\nstatus: "Next" # as typed\n---\nCall Mara Quill.\n';
const AFTER = '---\nstatus: Waiting\n---\nCall Mara Quill.\n';
const record: WriteRecord = { path: PATH, before: BEFORE, after: AFTER };

function viewWith(text: string) {
  const memory = memoryVault({ [PATH]: text });
  const fs = fakeVaultFs({ ...memory.fs });
  const toasts = createToasts();
  const onUndone = vi.fn();
  const panes = { state: () => 'closed' as const, reload: vi.fn() };
  const undo = { fs, toasts, panes, onUndone };
  const shown = () => toasts.store.getState().toasts;
  const pressUndo = async () => {
    const [toast] = shown();
    toast?.onUndo?.();
    toasts.dismiss(toast?.id ?? -1);
    await vi.waitFor(() => expect(onUndone.mock.calls.length + shown().length).toBeGreaterThan(0));
  };
  return { memory, toasts, onUndone, undo, shown, pressUndo };
}

describe('sayWritten', () => {
  it('says the change, in the words given, with an Undo', () => {
    const view = viewWith(AFTER);
    sayWritten({ record, words: 'Moved “Send the Larkspur invoice” to Waiting.', undo: view.undo });
    expect(view.shown()).toMatchObject([
      { message: 'Moved “Send the Larkspur invoice” to Waiting.', tone: 'change' },
    ]);
    expect(view.shown()[0]?.onUndo).toBeTypeOf('function');
  });

  it('says a change by the note’s name when given no words', () => {
    const view = viewWith(AFTER);
    sayWritten({ record, undo: view.undo });
    expect(view.shown()[0]?.message).toBe('Changed “Send the Larkspur invoice”.');
  });

  it('puts the exact bytes back on Undo, then has the view read again', async () => {
    const view = viewWith(AFTER);
    sayWritten({ record, undo: view.undo });
    await view.pressUndo();
    await vi.waitFor(() => expect(view.onUndone).toHaveBeenCalledTimes(1));
    expect(view.memory.files.get(PATH)).toBe(BEFORE);
  });

  it('says, as a warning, an Undo refused because the note moved on — and writes nothing', async () => {
    const later = AFTER.replace('Waiting', 'Done');
    const view = viewWith(later);
    sayWritten({ record, undo: view.undo });
    await view.pressUndo();
    await vi.waitFor(() => expect(view.shown()).toHaveLength(1));
    expect(view.shown()[0]).toMatchObject({
      tone: 'warning',
      message:
        '“Send the Larkspur invoice” has changed since — its properties changed — so the change was not undone.',
    });
    expect(view.shown()[0]?.onUndo).toBeUndefined();
    expect(view.memory.files.get(PATH)).toBe(later);
    expect(view.onUndone).not.toHaveBeenCalled();
  });

  it('says, as an error, an Undo the disk failed', async () => {
    const view = viewWith(AFTER);
    const failing = {
      ...view.undo,
      fs: fakeVaultFs({
        readTextFile: async () => ({ text: AFTER, modified: 1 }),
        writeTextFile: async () => {
          throw new Error('The disk is full.');
        },
      }),
    };
    sayWritten({ record, undo: failing });
    await view.pressUndo();
    await vi.waitFor(() => expect(view.shown()).toHaveLength(1));
    expect(view.shown()[0]).toMatchObject({ tone: 'error' });
    expect(view.shown()[0]?.message).toContain('The disk is full.');
  });
});

describe('sayWritten across a vault switch (#455)', () => {
  it('lets its toast go as another vault opens, and its Undo, pressed late, writes nothing', async () => {
    const view = viewWith(AFTER);
    view.toasts.openVault('/vaults/a');
    sayWritten({ record, undo: view.undo });
    const [toast] = view.shown();

    view.toasts.openVault('/vaults/b');
    expect(view.shown()).toEqual([]);
    toast?.onUndo?.();
    await Promise.resolve();

    expect(view.memory.files.get(PATH)).toBe(AFTER);
    expect(view.onUndone).not.toHaveBeenCalled();
    expect(view.shown()).toEqual([]);
  });
});
