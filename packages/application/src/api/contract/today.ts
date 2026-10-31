/**
 * The local API's contract for the Today page: its tasks, ticking one done, and
 * choosing for today.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

import type { ApiReviewTask, ApiWeeklyReview } from './review.ts';

/**
 * `POST /v1/today/choose` (#108): choose a task for today, or take it off, as
 * the Today page's Today, Keep and Drop do — its `focus` set to the app's
 * today, or taken out.
 */
export interface ApiChooseForTodayBody {
  /** The task's vault-relative path: a note of type task. */
  readonly path: string;
  /** True to choose it for today (or keep one carried over); false to take it off (or drop it). */
  readonly chosen: boolean;
}

/**
 * `POST /v1/tasks/done` (#107): tick a task done, or untick it, as a row's
 * done box does on the Today page and in a query view.
 */
export interface ApiTaskDoneBody {
  /** The task's vault-relative path: a note of type task. */
  readonly path: string;
  /** True to finish it (a repeating task rolls on instead); false to take a finished one back to Next Action. */
  readonly done: boolean;
  /** The task's `modified` as read: required to tick, so a tick sent twice never rolls a task on twice. */
  readonly ifModified?: number | undefined;
}

/** A task as the Today page lists it: a review task, and how long it has waited. */
export interface ApiTodayTask extends ApiReviewTask {
  /**
   * For a Waiting task, the whole days (24 hours each) since its file last
   * changed (`modified`) — not a recorded "waiting since". Null otherwise.
   */
  readonly waitingDays: number | null;
}

/** `GET /v1/today`: the Today page, as the app shows it. */
export interface ApiToday {
  /** The day it was taken, `YYYY-MM-DD`, where the app is. */
  readonly today: string;
  /**
   * Every section, in order — `chosen`, `carriedOver`, `overdue`,
   * `dueToday`, `backToday`, `inProgress`, `nextActions`, `waiting` — empty
   * ones included. A task is in one section only: the first that claims it.
   * `chosen` holds the open tasks whose `focus` is today, whatever their
   * status; `carriedOver` those chosen on an earlier day and not yet kept or
   * dropped (#108).
   */
  readonly sections: readonly {
    readonly id: string;
    readonly count: number;
    /**
     * `nextActions` by project (those under none last) and `waiting` by who
     * is waited on (nobody last); the other sections hold one unnamed group,
     * or none when empty.
     */
    readonly groups: readonly {
      readonly key: string;
      readonly label: string | null;
      /** The project's note, for a group of a project's tasks. */
      readonly project: string | null;
      readonly tasks: readonly ApiTodayTask[];
    }[];
  }[];
  /** Active projects with no Next Action or In Progress task: `projectsWithoutNextAction`, counted. */
  readonly stalledProjects: number;
  /**
   * Whether tasks can be chosen for today: the vault's Task type has `focus`
   * as a date (or there is no Task type yet). When false, `chosen` and
   * `carriedOver` are empty and `POST /v1/today/choose` is refused.
   */
  readonly choosing: boolean;
  /** As the weekly review's `inbox`. */
  readonly inbox: ApiWeeklyReview['inbox'];
  /** The index held tasks back, so a section may be missing tasks. */
  readonly truncated: boolean;
}

/** What the routes for the Today page: its tasks, ticking one done, and choosing for today answer with. */
export type ApiTodaySuccessBody = { readonly today: ApiToday };

/** The routes for the Today page: its tasks, ticking one done, and choosing for today. */
export const TODAY_ROUTES = [
  {
    method: 'GET',
    path: '/v1/today',
    summary:
      'The Today page: chosen, carried over, overdue, due today, back, in progress, next, waiting.',
  },
  {
    method: 'POST',
    path: '/v1/tasks/done',
    summary:
      'Tick a task done, or untick it, as its done box does: a repeating task rolls on. Answers the task.',
  },
  {
    method: 'POST',
    path: '/v1/today/choose',
    summary: 'Choose a task for today, or take it off, as the Today page does. Answers the task.',
  },
] as const;
