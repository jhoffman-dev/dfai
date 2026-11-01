// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { parseObjectType } from '@dfai/domain';
import { fakeVaultFs, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useNewView } from './use-new-view.ts';

/** The New view dialog, and where it gives up on writing the view. */

const TYPES = [parseObjectType({ name: 'task', properties: { status: 'select' } })];
const VIEWS = ['.atlas/views/Board.md'];

function dialog({ refuse = null }: { refuse?: string | null } = {}) {
  const activity = recordingActivity();
  const fs = fakeVaultFs({
    createNote: async () => {
      if (refuse !== null) throw new Error(refuse);
      return 0;
    },
  });
  const onCreated = vi.fn();
  const hook = renderHook(() =>
    useNewView({
      fs,
      markdown: remarkMarkdown,
      types: TYPES,
      viewPaths: VIEWS,
      activity,
      onCreated,
    }),
  );
  const create = (name: string) => {
    act(() => hook.result.current.change({ name, type: 'task', layout: 'table' }));
    act(() => hook.result.current.create());
  };
  return { hook, activity, onCreated, create };
}

describe('useNewView and the Activity log', () => {
  it('records a view that could not be written, once', async () => {
    const { hook, activity, create } = dialog({ refuse: 'The disk is full.' });
    create('Open work');
    await waitFor(() => expect(hook.result.current.problems).toEqual(['The disk is full.']));
    expect(activity.reports).toEqual([
      {
        level: 'error',
        kind: 'save',
        message: 'Could not save the view. The disk is full.',
        subject: null,
      },
    ]);
  });

  it('records nothing for a view made', async () => {
    const { activity, onCreated, create } = dialog();
    create('Open work');
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('.atlas/views/Open work.md'));
    expect(activity.reports).toEqual([]);
  });

  it('records nothing for a name the dialog refuses', async () => {
    const { hook, activity, onCreated, create } = dialog();
    create('board');
    await waitFor(() => expect(hook.result.current.problems.length).toBeGreaterThan(0));
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(onCreated).not.toHaveBeenCalled();
    expect(activity.reports).toEqual([]);
  });
});
