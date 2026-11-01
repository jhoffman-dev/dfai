// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, REVIEW_PROJECTS_QUERY_MARK, REVIEW_TASKS_QUERY_MARK } from '@dfai/domain';
import {
  fakeIndexPort,
  fakeVaultFs,
  memoryVault,
  recordingActivity,
  type QueryResult,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useWeeklyReview, type WeeklyReviewOptions } from './use-weekly-review.ts';

const ACTIVITY = recordingActivity();

/** P30-07, adversarial: the review page's reading across a vault switch. */
const NOW = Date.UTC(2026, 9, 8, 12);
const CLOCK = { today: () => '2026-10-08', now: () => NOW };
const TASK = createVaultPath('Tasks/Quote from Larkspur.md');
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

/** The first vault's index: one overdue task. */
function firstVaultAnswer(sql: string): QueryResult {
  if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
    return {
      columns: ['path', 'title', 'modified', 'status', 'due', 'defer', 'waitingOn', 'project'],
      rows: [[TASK, 'Quote from Larkspur', NOW, 'next-action', '2026-10-01', null, null, null]],
      truncated: false,
    };
  }
  if (sql.startsWith(REVIEW_PROJECTS_QUERY_MARK)) {
    return { columns: ['path', 'title', 'status'], rows: [], truncated: false };
  }
  return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
}

function portsOf(query: (sql: string) => Promise<QueryResult>) {
  return {
    index: fakeIndexPort({ query }),
    fs: fakeVaultFs(memoryVault({}).fs),
    markdown: remarkMarkdown,
  };
}

describe('useWeeklyReview, adversarial', () => {
  it("does not keep showing the previous vault's review, actions live, while the next vault's is read", async () => {
    const options = (
      ports: WeeklyReviewOptions['ports'],
      indexKey: string,
    ): WeeklyReviewOptions => ({
      ports,
      editors: noPane,
      activity: ACTIVITY,
      clock: CLOCK,
      types: [{ name: 'task', label: 'Task', properties: [] }],
      indexKey,
      open: true,
      onSettled: () => undefined,
      archiveNote: async () => null,
    });
    const first = portsOf(async (sql) => firstVaultAnswer(sql));
    const { result, rerender } = renderHook(
      (props: WeeklyReviewOptions) => useWeeklyReview(props),
      {
        initialProps: options(first, 'ready:1'),
      },
    );
    await waitFor(() => expect(result.current.page.review?.overdue).toHaveLength(1));

    // A vault switch: new ports, the index building, and its answer not in yet.
    const second = portsOf(() => new Promise<QueryResult>(() => undefined));
    rerender(options(second, 'building'));

    // Observed: the first vault's "Quote from Larkspur" is still listed, its Defer and Archive
    // enabled (busy false), and acting on it writes that path through the second vault's fs.
    expect(result.current.page.review).toBeNull();
  });
});
