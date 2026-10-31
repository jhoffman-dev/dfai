/**
 * The local API's contract for scheduling a task on the calendar.
 *
 * One area of `../contract.ts`, which composes every area's routes and
 * answers. Everything here is data. No behaviour belongs in this file.
 */

/**
 * `POST /v1/tasks/schedule` (P31-02): a block for a task, as a task let go on
 * the calendar's empty time makes one in the app.
 */
export interface ApiScheduleTaskBody {
  /** The task's vault-relative path: a note of type task. */
  readonly task: string;
  /** When the block starts, as local wall-clock time with no offset: `2026-10-12T09:00`. */
  readonly start: string;
  /**
   * How long it runs: whole minutes, 1 to 1440. Omitted: what the task still
   * needs — its estimate less what its blocks already give it — or 30 when it
   * has no estimate or needs nothing more, as the app sizes a dropped task.
   */
  readonly minutes?: number;
}

/** The routes for scheduling a task on the calendar. */
export const TASK_ROUTES = [
  {
    method: 'POST',
    path: '/v1/tasks/schedule',
    summary:
      'Make a block for a task, from a start for some minutes, linking it. Answers the block.',
  },
] as const;
