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
  // When the review reads again (#928) is the app's: it joins the contract with the API's slice of #912.
  const answeredReview = omitted(review, ['nextDueTurn']);
  return {
    status: 200,
    body: {
      review: {
        ...answeredReview,
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
  // What the contract answers, by name: the wall time it was read at (#928)
  // joins it with the API's slice of #912.
  const { today: day, choosing, inbox, truncated, stalledProjects } = today;
  return {
    status: 200,
    body: { today: { today: day, choosing, inbox, truncated, stalledProjects, sections } },
  };
}

/**
 * What a task holds that the contract does not answer: the names its project
 * links by, which are the app's own, to read Today again by (#392), and its
 * priority and its due's time (#928), which join the contract with the API's
 * slice of #912: `due` stays the day.
 */
const UNANSWERED: ReadonlySet<string> = new Set(['projectLinks', 'priority', 'dueTime', 'dueAt']);

type Unanswered = 'projectLinks' | 'priority' | 'dueTime' | 'dueAt';

/** A task as the contract answers it (`ApiReviewTask`). */
function answered<Task extends ReviewTask>(task: Task): Omit<Task, Unanswered> {
  const entries = Object.entries(task).filter(([key]) => !UNANSWERED.has(key));
  return Object.fromEntries(entries) as Omit<Task, Unanswered>;
}

/** A read with the keys the contract does not answer left out. */
function omitted<Read extends object, Key extends keyof Read>(
  read: Read,
  keys: readonly Key[],
): Omit<Read, Key> {
  const left = Object.entries(read).filter(([key]) => !(keys as readonly string[]).includes(key));
  return Object.fromEntries(left) as Omit<Read, Key>;
}
