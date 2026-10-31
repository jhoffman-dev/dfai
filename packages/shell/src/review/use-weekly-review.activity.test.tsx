// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, type ObjectType } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, NoteChangedError, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useWeeklyReview, type WeeklyReviewOptions } from './use-weekly-review.ts';

/**
 * The review's writes and the Activity log: a refusal is shown on the page
 * and never recorded; Waiting is written with nobody to wait on (#202); and a
 * task the review finishes is dated by the review's own clock, the one its
 * sections were read on.
 */
const TASK = createVaultPath('Tasks/Send Tobias the Larkspur file.md');
const TEXT = '---\ntype: task\nstatus: next-action\n---\n\n# Send\n';
const TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];
const NO_PANE = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

function reviewing({ changedOnDisk = false } = {}) {
  const activity = recordingActivity();
  const written: string[] = [];
  const fs = fakeVaultFs({
    readTextFile: async () => ({ text: TEXT, modified: 1 }),
    writeTextFile: async ({ path, contents }: { path: string; contents: string }) => {
      // The host refuses a write to a note that changed on disk since it was read.
      if (changedOnDisk) throw new NoteChangedError(path);
      written.push(contents);
      return 2;
    },
  });
  const options: WeeklyReviewOptions = {
    ports: {
      index: fakeIndexPort({ query: async () => ({ columns: [], rows: [], truncated: false }) }),
      fs,
      markdown: remarkMarkdown,
    },
    editors: NO_PANE,
    clock: { today: () => '2031-02-03', now: () => Date.UTC(2031, 1, 3, 12) },
    types: TYPES,
    indexKey: '1',
    open: true,
    onSettled: vi.fn(),
    archiveNote: async () => null,
    activity,
  };
  const hook = renderHook(() => useWeeklyReview(options));
  return { activity, hook, written };
}

describe('the weekly review’s writes', () => {
  it('shows a refusal and records nothing', async () => {
    const { activity, hook, written } = reviewing({ changedOnDisk: true });
    await act(async () => hook.result.current.page.onSetStatus({ path: TASK, status: 'waiting' }));
    await waitFor(() => expect(hook.result.current.page.problem).toMatch(/changed since/));
    expect(written).toEqual([]);
    expect(activity.reports).toEqual([]);
  });

  it('moves a task to Waiting with nobody to wait on, asking for no one (#202)', async () => {
    const { activity, hook, written } = reviewing();
    await act(async () => hook.result.current.page.onSetStatus({ path: TASK, status: 'waiting' }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toMatch(/^status: waiting$/m);
    expect(hook.result.current.page.problem).toBeNull();
    expect(activity.reports).toEqual([]);
  });

  it('dates a task it finishes by its own clock', async () => {
    const { hook, written } = reviewing();
    await act(async () => hook.result.current.page.onArchiveTask(TASK));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toMatch(/^completed: 2031-02-03$/m);
  });
});
