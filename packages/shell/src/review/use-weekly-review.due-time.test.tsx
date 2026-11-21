// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, REVIEW_TASKS_QUERY_MARK, type ObjectType } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, recordingActivity, type QueryResult } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useWeeklyReview } from './use-weekly-review.ts';

/** #928: a weekly review left open reads again once a timed due's time has passed, as Today does. */
const NOW = Date.UTC(2026, 11, 4, 12);
let wall = '2026-12-04T08:59:00';
const CLOCK = { today: () => '2026-12-04', now: () => NOW, localNow: () => wall };
const TASK = createVaultPath('Tasks/Call Mara Quill.md');
const TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

function answer(sql: string): QueryResult {
  if (!sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
    return { columns: ['path'], rows: [], truncated: false };
  }
  return {
    columns: ['path', 'title', 'modified', 'status', 'due', 'dueAt'],
    rows: [[TASK, 'Call Mara Quill', NOW, 'next-action', '2026-12-04', '2026-12-04T09:00']],
    truncated: false,
  };
}

beforeEach(() => {
  wall = '2026-12-04T08:59:00';
});

describe('useWeeklyReview, a timed due (#928)', () => {
  it('lists it as overdue once its time has passed, without being asked again', async () => {
    const query = vi.fn(async (sql: string) => answer(sql));
    // Made once: ports handed anew on each render would be read again on each.
    const ports = { index: fakeIndexPort({ query }), fs: fakeVaultFs(), markdown: remarkMarkdown };
    const activity = recordingActivity();
    const onSettled = vi.fn();
    const archiveNote = vi.fn(async () => null);
    const { result } = renderHook(() =>
      useWeeklyReview({
        ports,
        editors: noPane,
        activity,
        clock: CLOCK,
        types: TYPES,
        indexKey: '1',
        open: true,
        onSettled,
        archiveNote,
      }),
    );
    await waitFor(() => expect(result.current.page.review).not.toBeNull());
    expect(result.current.page.review?.overdue).toEqual([]);
    expect(result.current.page.review?.nextDueTurn).toBe('09:00');

    wall = '2026-12-04T09:01:00';
    // The window looked at again is asked as the minute's check is (`useDueTurns`), with no wait on real time.
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() =>
      expect(result.current.page.review?.overdue.map((task) => task.title)).toEqual([
        'Call Mara Quill',
      ]),
    );
    expect(result.current.page.review?.nextDueTurn).toBeNull();
  });
});
