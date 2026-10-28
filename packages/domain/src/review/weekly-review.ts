import {
  FINISHED_TASK_STATUS,
  GTD_STATUSES,
  TASK_KEYS,
  type GtdStatus,
} from '../gtd/gtd-status.ts';
import { addDays } from '../timeline/timeline.ts';
import type { VaultPath } from '../vault/vault-path.ts';

/** A task as the weekly review reads it. */
export interface ReviewTask {
  readonly path: VaultPath;
  readonly title: string;
  /** Its GTD status as the index reads it, or null when it holds none of the eight. */
  readonly status: GtdStatus | null;
  /** `YYYY-MM-DD`, or null when it has none. */
  readonly due: string | null;
  /** `YYYY-MM-DD`: the day it comes back into play; null when it is not deferred. */
  readonly defer: string | null;
  /**
   * How it repeats, as its `recurrence` says; null when it does not. Absent
   * when the read did not say, so a change worked out from it — finishing it,
   * which rolls a repeating task on — cannot be known before it is written.
   */
  readonly recurrence?: string | null;
  /**
   * The day it was chosen for (`focus`, #108), `YYYY-MM-DD`; null when it
   * has none. Absent when the read did not say, which is read as not chosen.
   */
  readonly focus?: string | null;
  /** Who it waits on, as its `waiting_on` names them; '' for nobody. */
  readonly waitingOn: string;
  /** Its `contexts`, as written, in order; none when it has none. */
  readonly contexts: readonly string[];
  /** The note its `project` links, or null when it links none that exists. */
  readonly project: VaultPath | null;
  /** That note's title, or null when it links none. */
  readonly projectTitle: string | null;
  /**
   * The names its `project` links by, as links find notes (folded), whether
   * or not a note goes by one yet. Absent when the read did not say.
   */
  readonly projectLinks?: readonly string[];
  /** When its file last changed, in milliseconds since the epoch. */
  readonly modified: number;
}

/** A project as the weekly review reads it. */
export interface ReviewProject {
  readonly path: VaultPath;
  readonly title: string;
  /** Its `status:` as written, trimmed; null when it has none. */
  readonly status: string | null;
  /** Whether a task in use filed under it is Next Action or In Progress, as the index says. */
  readonly moving: boolean;
}

/** What the weekly review puts in front of you, a section per question GTD asks of the week. */
export interface WeeklyReview {
  /** Waiting on someone, and not looked at for more than {@link STALE_WAITING_DAYS} days. */
  readonly staleWaiting: readonly ReviewTask[];
  /** Active, with no task in use filed under it that is moving ({@link MOVING_STATUSES}). */
  readonly projectsWithoutNextAction: readonly ReviewProject[];
  /** Due before today and still open. */
  readonly overdue: readonly ReviewTask[];
  /** Someday or Longterm, and not looked at for more than {@link UNTOUCHED_SOMEDAY_DAYS} days. */
  readonly untouchedSomeday: readonly ReviewTask[];
}

/** How long a Waiting task goes unlooked-at before the review asks about it. */
export const STALE_WAITING_DAYS = 7;

/** How long a Someday or Longterm task goes unlooked-at before the review asks about it. */
export const UNTOUCHED_SOMEDAY_DAYS = 30;

/** The project status that says work on it is under way. */
export const ACTIVE_PROJECT_STATUS = 'active';

/** How far the review's Defer puts a task off. */
export const REVIEW_DEFER_DAYS = 7;

/** A day, in milliseconds: what "N days untouched" counts in. */
export const DAY_MS = 86_400_000;

/** Work still open: an overdue task in one of these is late. Someday and Longterm promise no day. */
const COMMITTED: ReadonlySet<GtdStatus> = new Set([
  'inbox',
  'backlog',
  'next-action',
  'in-progress',
  'waiting',
]);

/**
 * What a task filed under a project counts as the project moving: something
 * to do next, or something under way. A deferred next action still counts —
 * the project knows what comes next, just not yet.
 */
export const MOVING_STATUSES: readonly GtdStatus[] = ['next-action', 'in-progress'];

const SOMEDAY: ReadonlySet<GtdStatus> = new Set(['someday', 'longterm']);

/** The review's sections of tasks. */
export type ReviewTaskSection = 'staleWaiting' | 'overdue' | 'untouchedSomeday';

/**
 * The statuses the review's Move offers a task in each section: only those
 * that take it out of the section, so acting on an item always clears it.
 * Finishing is Archive's, not a move. Any move takes a task out of Waiting or
 * Someday and Longterm; a late task stays late in every open status, so it is
 * moved only to Someday or Longterm, which promise no day — or deferred.
 */
export const REVIEW_MOVES: Readonly<Record<ReviewTaskSection, readonly GtdStatus[]>> = {
  staleWaiting: GTD_STATUSES.filter((status) => status !== FINISHED_TASK_STATUS),
  overdue: GTD_STATUSES.filter(
    (status) => !COMMITTED.has(status) && status !== FINISHED_TASK_STATUS,
  ),
  untouchedSomeday: GTD_STATUSES.filter((status) => status !== FINISHED_TASK_STATUS),
};

/** The moment the review is taken: today where the person is, and now. */
export interface ReviewMoment {
  /** `YYYY-MM-DD`, from the injected clock. */
  readonly today: string;
  /** Milliseconds since the epoch, from the injected clock. */
  readonly now: number;
}

/**
 * The weekly review (P30-07): GTD's questions of the week, answered from the
 * tasks and projects the vault holds.
 *
 * A task's file last changing is when it was last looked at — DFAI keeps no
 * "waiting since" key (ADR-0029 turned down keys nobody asked for), so any
 * edit, including the review's own, counts as a look. A task deferred to a
 * later day is out of every section until that day, as it is out of Next
 * actions: that is what Defer is for.
 */
export function weeklyReview({
  tasks,
  projects,
  at,
}: {
  tasks: readonly ReviewTask[];
  projects: readonly ReviewProject[];
  at: ReviewMoment;
}): WeeklyReview {
  const inPlay = tasks.filter((task) => !isDeferred(task, at.today));
  return {
    staleWaiting: oldestFirst(
      inPlay.filter(
        (task) => task.status === 'waiting' && untouchedFor(task, STALE_WAITING_DAYS, at),
      ),
    ),
    projectsWithoutNextAction: stalledProjects(projects),
    overdue: inPlay.filter((task) => isOverdue(task, at.today)).sort(byDueThenTitle),
    untouchedSomeday: oldestFirst(
      inPlay.filter(
        (task) =>
          task.status !== null &&
          SOMEDAY.has(task.status) &&
          untouchedFor(task, UNTOUCHED_SOMEDAY_DAYS, at),
      ),
    ),
  };
}

/** Active projects with no task in use filed under them that is moving, by title. */
export function stalledProjects(projects: readonly ReviewProject[]): ReviewProject[] {
  return projects
    .filter((project) => project.status === ACTIVE_PROJECT_STATUS && !project.moving)
    .sort(byTitle);
}

/** Put off to a later day than today: out of play until that day. */
export function isDeferred(task: ReviewTask, today: string): boolean {
  return task.defer !== null && task.defer > today;
}

/** Whether a task's status promises its day: open work, not Someday, Longterm or finished. */
export function promisesItsDay(task: ReviewTask): boolean {
  return task.status !== null && COMMITTED.has(task.status);
}

/** More than `days` whole days since the file last changed. */
function untouchedFor(task: ReviewTask, days: number, at: ReviewMoment): boolean {
  return at.now - task.modified > days * DAY_MS;
}

/** Due before today, on a status that promises its day. */
export function isOverdue(task: ReviewTask, today: string): boolean {
  return task.due !== null && task.due < today && promisesItsDay(task);
}

/** Longest untouched first: what has waited longest is asked about first. */
function oldestFirst(tasks: ReviewTask[]): ReviewTask[] {
  return tasks.sort((left, right) => left.modified - right.modified || byTitle(left, right));
}

function byDueThenTitle(left: ReviewTask, right: ReviewTask): number {
  return (left.due ?? '').localeCompare(right.due ?? '') || byTitle(left, right);
}

export function byTitle(
  left: { title: string; path: string },
  right: { title: string; path: string },
) {
  return left.title.localeCompare(right.title) || left.path.localeCompare(right.path);
}

/** What the review's Defer writes into a task: back in play {@link REVIEW_DEFER_DAYS} days from today. */
export function reviewDeferral(today: string): Readonly<Record<string, string>> | null {
  return taskDeferral({ today, days: REVIEW_DEFER_DAYS });
}

/**
 * What putting a task off writes into it: back in play `days` days from
 * today, counted on the calendar, so a clock change in between moves nothing.
 * Null when today cannot be read as a day.
 */
export function taskDeferral({
  today,
  days,
}: {
  today: string;
  days: number;
}): Readonly<Record<string, string>> | null {
  const day = addDays(today, days);
  return day === null ? null : { [TASK_KEYS.defer]: day };
}
