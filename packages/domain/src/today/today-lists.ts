import { FINISHED_TASK_STATUS, GTD_STATUSES, type GtdStatus } from '../gtd/gtd-status.ts';
import {
  byTitle,
  DAY_MS,
  isDeferred,
  isOverdue,
  promisesItsDay,
  stalledProjects,
  type ReviewMoment,
  type ReviewProject,
  type ReviewTask,
} from '../review/weekly-review.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import { focusStanding, laterChoiceOf } from './chosen.ts';

/** The Today page's sections, in the order they are shown and claim their tasks. */
export const TODAY_SECTIONS = [
  'chosen',
  'carriedOver',
  'overdue',
  'dueToday',
  'backToday',
  'inProgress',
  'nextActions',
  'waiting',
] as const;

export type TodaySectionId = (typeof TODAY_SECTIONS)[number];

/** What each section is called, on the page and to whoever reads it through the API. */
export const TODAY_SECTION_LABELS: Readonly<Record<TodaySectionId, string>> = {
  chosen: 'Chosen for today',
  carriedOver: 'Carried over',
  overdue: 'Overdue',
  dueToday: 'Due today',
  backToday: 'Back from deferral',
  inProgress: 'In progress',
  nextActions: 'Next actions',
  waiting: 'Waiting',
};

/** How far the page's Defer buttons put a task off, in days. */
export const TODAY_DEFER_DAYS = [1, 7] as const;

/**
 * The statuses the page's Move offers: every one but Archive, which is the
 * done box's — ticking finishes a task as a type's view does, and rolls a
 * repeating one on.
 */
export const TODAY_MOVES: readonly GtdStatus[] = GTD_STATUSES.filter(
  (status) => status !== FINISHED_TASK_STATUS,
);

/** The statuses Move offers one task: every one of {@link TODAY_MOVES} but its own. */
export function todayMovesFor(status: GtdStatus | null): readonly GtdStatus[] {
  return TODAY_MOVES.filter((offered) => offered !== status);
}

/** A task as the Today page lists it. */
export interface TodayTask extends ReviewTask {
  /**
   * For a Waiting task, the whole days (24 hours each) since its file last
   * changed — the review's measure of "untouched" (ADR-0029), not a recorded
   * "waiting since": any edit to the file starts the count again. Null for
   * any other status.
   */
  readonly waitingDays: number | null;
  /**
   * The day still to come it was chosen for (#108), `YYYY-MM-DD`: a choice
   * of that day's, which its row says and Today moves to today. Null when it
   * was chosen for no later day, or the vault does not choose.
   */
  readonly laterChoice: string | null;
}

/** Tasks listed together under one name: a project's next actions, or what one person owes. */
export interface TodayGroup {
  /** Tells the section's groups apart: the project's path, the person's name, '' for neither. */
  readonly key: string;
  /** The project's title or the person's name; null when the tasks have none, or the section is not grouped. */
  readonly label: string | null;
  /** The project's note, for a group of a project's tasks; otherwise null. */
  readonly project: VaultPath | null;
  readonly tasks: readonly TodayTask[];
}

export interface TodaySection {
  readonly id: TodaySectionId;
  /** How many tasks it holds, across its groups. */
  readonly count: number;
  /** None when the section is empty; one, unnamed, when it is not grouped. */
  readonly groups: readonly TodayGroup[];
}

/** What the Today page puts in front of you: each task once, in the first section that claims it. */
export interface TodayLists {
  /** Every section, in {@link TODAY_SECTIONS} order, empty ones included. */
  readonly sections: readonly TodaySection[];
  /** Active projects with nothing next or under way: the weekly review's list, counted. */
  readonly stalledProjects: number;
}

/**
 * The Today page (#111): what needs you today, from the tasks the vault holds.
 *
 * A task is listed once, in the first section in {@link TODAY_SECTIONS} order
 * that claims it, so the counts add up to the tasks on the page: an In
 * Progress task due yesterday is under Overdue only. A task deferred to a
 * later day is in no section until that day, as it is out of the weekly
 * review and of Next actions. Late and due-today are only said of open work —
 * Someday and Longterm promise no day. A finished task is in no section
 * (ADR-0029), whatever rows the caller hands over.
 *
 * The page leads with what was chosen for today (#108): a task whose
 * `focus` is today, whatever its status, is under Chosen for today alone. One
 * chosen on an earlier day and still open is under Carried over, to be kept
 * for today or dropped, until it is; a choice is of its day, so nothing has
 * to change at midnight for yesterday's to stop being today's. A `focus` on a
 * day still to come is that day's choice, and lists the task where it would
 * be otherwise.
 *
 * Back from deferral is a task whose `defer` day is today — or has passed,
 * when no later section would list it: a Backlog or Someday task put off to
 * a day the app was never opened still wakes up somewhere, and stays until
 * it is dealt with or put off again. A Next Action whose day has passed is
 * simply a next action again.
 */
export function todayLists({
  tasks,
  projects,
  at,
  choosing = true,
}: {
  tasks: readonly ReviewTask[];
  projects: readonly ReviewProject[];
  at: ReviewMoment;
  /**
   * Whether the vault chooses for today (`choosesForToday`): when it does
   * not, no task is chosen or carried over, whatever its `focus` holds.
   */
  choosing?: boolean;
}): TodayLists {
  let unclaimed = tasks
    .filter((task) => task.status !== FINISHED_TASK_STATUS && !isDeferred(task, at.today))
    .map(asListed({ at, choosing }));
  const sections = TODAY_SECTIONS.map((id) => {
    const claims = choosing || !CHOICE_SECTIONS.has(id) ? CLAIMS[id] : NONE;
    const claimed = unclaimed.filter((task) => claims(task, at.today));
    const taken = new Set(claimed);
    unclaimed = unclaimed.filter((task) => !taken.has(task));
    return { id, count: claimed.length, groups: GROUPS[id](claimed) };
  });
  return { sections, stalledProjects: stalledProjects(projects).length };
}

const asListed =
  ({ at, choosing }: { at: ReviewMoment; choosing: boolean }) =>
  (task: ReviewTask): TodayTask => ({
    ...task,
    waitingDays:
      task.status === 'waiting' ? Math.max(0, Math.floor((at.now - task.modified) / DAY_MS)) : null,
    laterChoice: laterChoiceOf({ ...task, today: at.today, choosing }),
  });

/** The sections a task is in by what it was chosen for. */
const CHOICE_SECTIONS: ReadonlySet<TodaySectionId> = new Set(['chosen', 'carriedOver']);

const NONE = () => false;

/** Where a task stands with the day: a `focus` that is the person's own is no choice. */
const standingOf = (task: TodayTask, today: string) =>
  task.focusIsOwn === true ? 'none' : focusStanding({ focus: task.focus, today });

/** What puts a task in each section, asked in {@link TODAY_SECTIONS} order. */
const CLAIMS: Readonly<Record<TodaySectionId, (task: TodayTask, today: string) => boolean>> = {
  chosen: (task, today) => standingOf(task, today) === 'today',
  carriedOver: (task, today) => standingOf(task, today) === 'carried',
  overdue: isOverdue,
  dueToday: (task, today) => task.due === today && promisesItsDay(task),
  backToday: (task, today) =>
    task.defer !== null &&
    task.status !== null &&
    (task.defer === today || (task.defer < today && !LISTED_BY_STATUS.has(task.status))),
  inProgress: (task) => task.status === 'in-progress',
  nextActions: (task) => task.status === 'next-action',
  waiting: (task) => task.status === 'waiting',
};

/** The statuses a later section lists a task by, deferred once or not. */
const LISTED_BY_STATUS: ReadonlySet<GtdStatus> = new Set(['in-progress', 'next-action', 'waiting']);

const GROUPS: Readonly<Record<TodaySectionId, (tasks: TodayTask[]) => TodayGroup[]>> = {
  chosen: (tasks) => together(tasks.sort(byDueThenTitle)),
  carriedOver: (tasks) => together(tasks.sort(byFocusThenTitle)),
  overdue: (tasks) => together(tasks.sort(byDueThenTitle)),
  dueToday: (tasks) => together(tasks.sort(byTitle)),
  backToday: (tasks) => together(tasks.sort(byDeferThenTitle)),
  inProgress: (tasks) => together(tasks.sort(byDueThenTitle)),
  nextActions: byProject,
  waiting: byPerson,
};

/** A section that is not grouped: its tasks under no name, or no group at all when it is empty. */
function together(tasks: TodayTask[]): TodayGroup[] {
  return tasks.length === 0 ? [] : [{ key: '', label: null, project: null, tasks }];
}

/** Next actions under their projects, by title; those filed under none come last. */
function byProject(tasks: TodayTask[]): TodayGroup[] {
  return grouped({
    tasks,
    keyOf: (task) => task.project ?? '',
    groupOf: (first) => ({ label: first.projectTitle, project: first.project }),
    order: byDueThenTitle,
  });
}

/** Waiting tasks under who they wait on, by name; those waiting on nobody come last. The longest wait first. */
function byPerson(tasks: TodayTask[]): TodayGroup[] {
  return grouped({
    tasks,
    keyOf: (task) => task.waitingOn,
    groupOf: (first) => ({
      label: first.waitingOn === '' ? null : first.waitingOn,
      project: null,
    }),
    order: (left, right) => left.modified - right.modified || byTitle(left, right),
  });
}

function grouped({
  tasks,
  keyOf,
  groupOf,
  order,
}: {
  tasks: readonly TodayTask[];
  keyOf: (task: TodayTask) => string;
  groupOf: (first: TodayTask) => Pick<TodayGroup, 'label' | 'project'>;
  order: (left: TodayTask, right: TodayTask) => number;
}): TodayGroup[] {
  const byKey = new Map<string, TodayTask[]>();
  for (const task of tasks) {
    const members = byKey.get(keyOf(task));
    if (members === undefined) byKey.set(keyOf(task), [task]);
    else members.push(task);
  }
  return [...byKey]
    .map(([key, members]) => {
      const sorted = members.sort(order);
      return { key, ...groupOf(sorted[0] as TodayTask), tasks: sorted };
    })
    .sort(namedFirstByLabel);
}

function namedFirstByLabel(left: TodayGroup, right: TodayGroup): number {
  if (left.label === null || right.label === null) {
    return Number(left.label === null) - Number(right.label === null);
  }
  return left.label.localeCompare(right.label) || left.key.localeCompare(right.key);
}

/** Today's first, then the most recently passed. */
function byDeferThenTitle(left: TodayTask, right: TodayTask): number {
  return (right.defer ?? '').localeCompare(left.defer ?? '') || byTitle(left, right);
}

/** The most recently chosen first: yesterday's before last week's. */
function byFocusThenTitle(left: TodayTask, right: TodayTask): number {
  return (right.focus ?? '').localeCompare(left.focus ?? '') || byTitle(left, right);
}

/** The earliest day first; a task with no day after every task with one. */
function byDueThenTitle(left: TodayTask, right: TodayTask): number {
  if (left.due === null || right.due === null) {
    return Number(left.due === null) - Number(right.due === null) || byTitle(left, right);
  }
  return left.due.localeCompare(right.due) || byTitle(left, right);
}

/**
 * Every row on the page, top to bottom: the order focus moves through them.
 * The page's keyboard model is built on this list, not on the DOM.
 */
export function todayRowOrder(page: TodayLists): VaultPath[] {
  return page.sections.flatMap((section) =>
    section.groups.flatMap((group) => group.tasks.map((task) => task.path)),
  );
}

/**
 * Where focus goes once a row has been acted on and may leave the page: the
 * row under it, or the one above when it was last. Null when it was the only row.
 */
export function rowToFocusAfter({
  order,
  acted,
}: {
  order: readonly VaultPath[];
  acted: VaultPath;
}): VaultPath | null {
  const at = order.indexOf(acted);
  if (at === -1) return null;
  return order[at + 1] ?? order[at - 1] ?? null;
}
