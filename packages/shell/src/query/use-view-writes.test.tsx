// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  fakeVaultFs,
  memoryVault,
  recordingActivity,
  TaskRuleRefusedError,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { createToasts } from '../toasts/toasts.ts';
import { useChangeProperties, useWriteProperties } from './use-view-writes.ts';

/**
 * The one write behind a view's gestures and a dashboard's edits — a cell, a
 * card moved, a widget placed — and where it gives up.
 */

const NOTE = 'Tasks/Call Mara.md';
const TEXT = ['---', 'type: task', 'status: todo', '---', '', '# Call Mara', ''].join('\n');
const NO_PANE: OpenEditors = {
  register: () => {},
  setPropertiesIfOpen: async () => false,
  savePane: () => {},
  reloadOthers: () => {},
};

function changing({ refuse, text = TEXT }: { refuse: string | Error | null; text?: string }) {
  const activity = recordingActivity();
  const written: string[] = [];
  const fs = fakeVaultFs({
    readTextFile: async () => ({ text, modified: 1 }),
    writeTextFile: async ({ contents }: { contents: string }) => {
      if (refuse !== null) throw typeof refuse === 'string' ? new Error(refuse) : refuse;
      written.push(contents);
      return 2;
    },
  });
  const onChanged = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() =>
    useChangeProperties({
      editors: NO_PANE,
      fs,
      markdown: remarkMarkdown,
      activity,
      onChanged,
      onError,
    }),
  );
  const change = (values: Readonly<Record<string, unknown>> = { status: 'done' }) =>
    act(() => hook.result.current({ path: NOTE, values }));
  return { activity, onChanged, onError, change, written };
}

describe('useChangeProperties and the Activity log', () => {
  it('records a write the view gives up on once, naming the note', async () => {
    const { activity, onError, change } = changing({ refuse: 'The disk is full.' });
    change();
    await waitFor(() => expect(onError).toHaveBeenCalledWith('The disk is full.'));
    expect(activity.reports).toEqual([
      {
        level: 'error',
        kind: 'save',
        message: 'Could not save an edit — Call Mara. The disk is full.',
        subject: { kind: 'note', path: NOTE },
      },
    ]);
  });

  it('records nothing for a task rule’s refusal, which the view shows to act on', async () => {
    const refusal = new TaskRuleRefusedError('A rule says no.');
    const { activity, onError, change } = changing({ refuse: refusal });
    change();
    await waitFor(() => expect(onError).toHaveBeenCalledWith('A rule says no.'));
    expect(activity.reports).toEqual([]);
  });

  it('records nothing for the frontmatter writer’s refusal, which the view shows to act on (#284)', async () => {
    const twice = ['---', 'type: task', 'status: todo', 'status: doing', '---', ''].join('\n');
    const { activity, onError, change, written } = changing({ refuse: null, text: twice });
    change();
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        `This note's properties list "status" twice; fix it in the source before changing it.`,
      ),
    );
    expect(activity.reports).toEqual([]);
    expect(written).toEqual([]);
  });

  it('moves a card dragged to Waiting with nobody to wait on, asking for no one (#202)', async () => {
    const { activity, onChanged, onError, change, written } = changing({ refuse: null });
    change({ status: 'waiting' });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^status: waiting$/m);
    expect(onError).not.toHaveBeenCalled();
    expect(activity.reports).toEqual([]);
  });

  it('records nothing for a write that lands', async () => {
    const { activity, onChanged, change } = changing({ refuse: null });
    change();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(activity.reports).toEqual([]);
  });
});

describe('useWriteProperties and the toasts (#320)', () => {
  function writing({ pane = false }: { pane?: boolean } = {}) {
    const memory = memoryVault({ [NOTE]: TEXT });
    const toasts = createToasts();
    const onUndone = vi.fn();
    const editors: OpenEditors = { ...NO_PANE, setPropertiesIfOpen: async () => pane };
    const hook = renderHook(() =>
      useWriteProperties({
        editors,
        fs: fakeVaultFs(memory.fs),
        markdown: remarkMarkdown,
        activity: recordingActivity(),
        undo: { toasts, panes: { state: () => 'closed', reload: vi.fn() }, onUndone },
      }),
    );
    const shown = () => toasts.store.getState().toasts;
    return { hook, memory, shown, onUndone };
  }

  it('says a row’s change in the words given, and its Undo puts the exact bytes back', async () => {
    const view = writing();
    await act(() =>
      view.hook.result.current({
        path: NOTE,
        values: { status: 'done' },
        said: 'Moved “Call Mara” to done.',
      }),
    );
    expect(view.shown()).toMatchObject([{ message: 'Moved “Call Mara” to done.', tone: 'change' }]);
    expect(view.memory.files.get(NOTE)).not.toBe(TEXT);

    act(() => view.shown()[0]?.onUndo?.());

    await waitFor(() => expect(view.onUndone).toHaveBeenCalledTimes(1));
    expect(view.memory.files.get(NOTE)).toBe(TEXT);
  });

  it('offers no Undo for a note a pane wrote: the pane holds its own history', async () => {
    const view = writing({ pane: true });
    await act(() => view.hook.result.current({ path: NOTE, values: { status: 'done' } }));
    expect(view.shown()).toEqual([]);
  });
});
