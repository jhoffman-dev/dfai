/**
 * #720 (ADR-0053): a vault that cannot tell when a file was written — the
 * GitHub vault — gives each task an unknown time. An unknown time is never
 * stale and never a long wait; read as a number it would be either.
 */
import { describe, expect, it } from 'vitest';
import { todayLists, type TodaySectionId } from '../today/today-lists.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { reviewTask } from './review-query.ts';
import { weeklyReview, type ReviewTask } from './weekly-review.ts';

const NOW = Date.UTC(2026, 9, 8, 12);
const DAY = 86_400_000;
const AT = { today: '2026-10-08', now: NOW };

function task(title: string, fields: Partial<ReviewTask>): ReviewTask {
  return {
    path: createVaultPath(`Tasks/${title}.md`),
    title,
    status: 'waiting',
    due: null,
    defer: null,
    waitingOn: 'Mara Quill',
    contexts: [],
    project: null,
    projectTitle: null,
    modified: null,
    ...fields,
  };
}

const waitingTasks = (tasks: readonly ReviewTask[], id: TodaySectionId = 'waiting') =>
  todayLists({ tasks, projects: [], at: AT }).sections.find((section) => section.id === id)!
    .groups[0]!.tasks;

describe('a task whose file time is unknown', () => {
  it('is read from an index row whose time is NULL as unknown, not as 1970', () => {
    expect(
      reviewTask({ path: 'Tasks/Quote.md', title: 'Quote', modified: null }).modified,
    ).toBeNull();
    expect(reviewTask({ path: 'Tasks/Quote.md', title: 'Quote', modified: 1_000 }).modified).toBe(
      1_000,
    );
  });

  it('is never in the weekly review’s stale lists', () => {
    const review = weeklyReview({
      tasks: [
        task('Quote', {}),
        task('Learn the cello', { status: 'someday' }),
        task('Signed lease', { modified: NOW - 20 * DAY }),
      ],
      projects: [],
      at: AT,
    });
    expect(review.staleWaiting.map(({ title }) => title)).toEqual(['Signed lease']);
    expect(review.untouchedSomeday).toEqual([]);
  });

  it('has no waiting days on Today, and is listed after the waits whose length is known', () => {
    const tasks = waitingTasks([
      task('Quote', {}),
      task('Signed lease', { modified: NOW - 3 * DAY }),
    ]);
    expect(tasks.map(({ title, waitingDays }) => [title, waitingDays])).toEqual([
      ['Signed lease', 3],
      ['Quote', null],
    ]);
  });
});
