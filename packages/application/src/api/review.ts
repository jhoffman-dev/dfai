import type { ReviewTask } from '@dfai/domain';
import { readWeeklyReview } from '../review/read-weekly-review.ts';
import { readToday } from '../today/read-today.ts';
import { ApiError, messageWithoutPaths } from './api-error.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

/**
 * The weekly review (P30-07), as its page shows it: read from the index on
 * the app's clock. It writes nothing; its quick actions are the routes that
 * already write — a status or a defer through PATCH properties, held to the
 * task rules, and a project into the Archive.
 */
export async function weeklyReviewRoute(request: VaultRequest): Promise<RouteResult> {
  const { index, fs, markdown, clock } = request;
  const review = await readWeeklyReview({ index, fs, markdown, clock }).catch((error: unknown) => {
    throw new ApiError(
      'query_failed',
      `The index could not take the weekly review: ${messageWithoutPaths(error)}`,
    );
  });
  return {
    status: 200,
    body: {
      review: {
        ...review,
        staleWaiting: review.staleWaiting.map(answered),
        overdue: review.overdue.map(answered),
        untouchedSomeday: review.untouchedSomeday.map(answered),
      },
    },
  };
}

/**
 * The Today page (#111), as the app shows it: the same read, on the app's
 * clock. It writes nothing; a tick, a move and a defer are the routes that
 * already write, as the weekly review's actions are, and choosing a task for
 * today is `POST /v1/today/choose` (#108).
 */
export async function todayRoute(request: VaultRequest): Promise<RouteResult> {
  const { index, fs, markdown, clock } = request;
  const today = await readToday({ index, fs, markdown, clock }).catch((error: unknown) => {
    throw new ApiError(
      'query_failed',
      `The index could not take the Today page: ${messageWithoutPaths(error)}`,
    );
  });
  const sections = today.sections.map((section) => ({
    ...section,
    groups: section.groups.map((group) => ({ ...group, tasks: group.tasks.map(answered) })),
  }));
  return { status: 200, body: { today: { ...today, sections } } };
}

/**
 * A task as the contract answers it (`ApiReviewTask`): without the names its
 * project links by, which are the app's own, to read Today again by (#392).
 */
function answered<Task extends ReviewTask>(task: Task): Omit<Task, 'projectLinks'> {
  const entries = Object.entries(task).filter(([key]) => key !== 'projectLinks');
  return Object.fromEntries(entries) as Omit<Task, 'projectLinks'>;
}
