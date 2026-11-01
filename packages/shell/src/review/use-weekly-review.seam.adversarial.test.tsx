// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, type ObjectType } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useWeeklyReview, type WeeklyReviewOptions } from './use-weekly-review.ts';

/*
 * Seam #75 (Activity: record where a screen gives up on a write, issue #1) x
 * #68 (weekly review, merged after it): the review is a screen whose write
 * failures show only in its own place, so where it gives up is recorded once
 * in the Activity log — as the view and type-table writes are. A task rule's
 * refusal is shown, never recorded.
 */
const TASK = createVaultPath('Tasks/Send Tobias the Larkspur file.md');
const TEXT = '---\ntype: task\nstatus: next-action\n---\n\n# Send\n';
const TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];
const NO_PANE = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

function reviewing({ refuse }: { refuse: string | null }) {
  const activity = recordingActivity();
  const fs = fakeVaultFs({
    readTextFile: async () => ({ text: TEXT, modified: 1 }),
    writeTextFile: async () => {
      if (refuse !== null) throw new Error(refuse);
      return 2;
    },
  });
  const options = {
    ports: {
      index: fakeIndexPort({
        query: async () => ({ columns: [], rows: [], truncated: false }),
      }),
      fs,
      markdown: remarkMarkdown,
    },
    editors: NO_PANE,
    clock: { today: () => '2026-10-08', now: () => Date.UTC(2026, 9, 8, 12) },
    types: TYPES,
    indexKey: '1',
    open: true,
    onSettled: vi.fn(),
    archiveNote: async () => null,
    activity,
  } as WeeklyReviewOptions;
  const hook = renderHook(() => useWeeklyReview(options));
  return { activity, hook };
}

describe('the weekly review and the Activity log', () => {
  it('records once where the review gives up on archiving a task', async () => {
    const { activity, hook } = reviewing({ refuse: 'The disk is full.' });
    await act(async () => hook.result.current.page.onArchiveTask(TASK));
    await waitFor(() => expect(hook.result.current.page.problem).toBe('The disk is full.'));
    expect(activity.reports).toEqual([
      expect.objectContaining({
        level: 'error',
        kind: 'save',
        subject: { kind: 'note', path: TASK },
      }),
    ]);
  });
});
