import { outsideArchiveSql } from '../archive/archive.ts';
import { FINISHED_TASK_STATUS, gtdStatusOf, TASK_KEYS, TASK_TYPE } from '../gtd/gtd-status.ts';
import { splitWikiLinks, wikiLinkLabel } from '../markdown/wikilink.ts';
import type { CompiledQuery } from '../query/view-query.ts';
import { FILED_UNDER_KEY, PROJECT_TYPE } from '../types/para.ts';
import { paraProjectSql } from '../types/para-value.ts';
import { RECURRENCE_KEY } from '../query/repeating-task.ts';
import { createVaultPath } from '../vault/vault-path.ts';
import { userSpaceNoteSql } from '../vault/vault-visibility.ts';
import { MEETING_TYPE } from '../meetings/meeting-header.ts';
import type { ReviewSource } from './review-draft.ts';
import { MOVING_STATUSES, type ReviewProject, type ReviewTask } from './weekly-review.ts';

/** What the review's statements start with, so a log or a stand-in index can tell them apart. */
export const REVIEW_TASKS_QUERY_MARK = '/* weekly review: tasks */';
export const REVIEW_PROJECTS_QUERY_MARK = '/* weekly review: projects */';

/** The key a project's status is kept under, as the Project type writes it. */
export const PROJECT_STATUS_KEY = 'status';

/** Between the items of a list the statement joins into one cell: a character no name holds. */
const ITEM_SEPARATOR = '\u001f';

/** A note at `column` of a type, in use: in user space and out of the Archive. */
function inUseOfTypeSql(column: string, typeParameter: string): string {
  return [
    `EXISTS (SELECT 1 FROM props AS ty WHERE ty.path = ${column} AND ty.key = 'type'`,
    `    AND lower(trim(ty.value_text)) = ${typeParameter})`,
    `  AND ${outsideArchiveSql(column)}`,
    `  AND ${userSpaceNoteSql(column)}`,
  ].join('\n');
}

/**
 * A property's one value as text: null when it has none, or holds a list of
 * several — a blank item being no item, as gtdStatusOf and a query's FROM
 * read it (follow-up to #110).
 */
const singleText = (key: string, column = 'f.path') =>
  `(SELECT CASE WHEN count(*) = 1 THEN max(p.value_text) END FROM props AS p WHERE p.path = ${column} AND p.key = '${key}' AND COALESCE(p.value_text, p.value_json, '') <> '')`;

/** A date property's first day, `YYYY-MM-DD`; null when it holds no date. */
const firstDay = (key: string) =>
  `(SELECT substr(p.value_date, 1, 10) FROM props AS p WHERE p.path = f.path AND p.key = '${key}' AND p.value_date IS NOT NULL ORDER BY p.idx LIMIT 1)`;

/**
 * Every item a property holds, in order, joined by {@link ITEM_SEPARATOR}:
 * text as written, a nested value as its JSON — as the task rules read it.
 */
const allItems = (key: string) =>
  `(SELECT group_concat(v, char(31)) FROM (SELECT coalesce(p.value_text, p.value_json) AS v FROM props AS p WHERE p.path = f.path AND p.key = '${key}' ORDER BY p.idx))`;

/**
 * The tasks the weekly review reads, asked of the index: every task in use
 * that is not finished — a finished task is in no section. Read whole, not a
 * page at a time: the review is of everything, and the index says when it
 * held back rows.
 */
export function compileReviewTasksQuery(): CompiledQuery {
  return {
    sql: [
      `${REVIEW_TASKS_QUERY_MARK} SELECT f.path AS "path", f.title AS "title", f.modified AS "modified",`,
      `  ${singleText(TASK_KEYS.status)} AS "status",`,
      `  ${firstDay(TASK_KEYS.due)} AS "due",`,
      `  ${firstDay(TASK_KEYS.defer)} AS "defer",`,
      `  ${singleText(RECURRENCE_KEY)} AS "recurrence",`,
      `  ${allItems(TASK_KEYS.waitingOn)} AS "waitingOn",`,
      `  ${allItems(TASK_KEYS.contexts)} AS "contexts",`,
      `  (SELECT r.dst FROM relations AS r WHERE r.src = f.path AND r.key = '${FILED_UNDER_KEY}' AND r.dst IS NOT NULL ORDER BY r.idx LIMIT 1) AS "project",`,
      `  (SELECT pf.title FROM relations AS r JOIN files AS pf ON pf.path = r.dst WHERE r.src = f.path AND r.key = '${FILED_UNDER_KEY}' ORDER BY r.idx LIMIT 1) AS "projectTitle",`,
      `  (SELECT group_concat(n, char(31)) FROM (SELECT r.name AS n FROM relations AS r WHERE r.src = f.path AND r.key = '${FILED_UNDER_KEY}' ORDER BY r.idx)) AS "projectLinks"`,
      `FROM files AS f`,
      `WHERE ${inUseOfTypeSql('f.path', '?')}`,
      // Finished is a status of archive, read as its one value: a status
      // written as a list is no status, so the task is open work, shown rather
      // than hidden — as a query's `status != archive` lists it.
      `  AND COALESCE(${singleText(TASK_KEYS.status)}, '') <> ?`,
      `ORDER BY f.path`,
    ].join('\n'),
    parameters: [TASK_TYPE, FINISHED_TASK_STATUS],
  };
}

/**
 * The projects the weekly review reads, asked of the index: every project in
 * use — a Project note whose PARA is project, not an area, a resource or
 * archived (#213) — and whether a task in use filed under it is moving. That is asked of
 * the index here rather than worked out from the tasks the review read, which
 * the host's row cap can cut short: a project is never called stalled on the
 * strength of tasks that were not read.
 */
export function compileReviewProjectsQuery(): CompiledQuery {
  const moving = MOVING_STATUSES.map(() => '?').join(', ');
  return {
    sql: [
      `${REVIEW_PROJECTS_QUERY_MARK} SELECT f.path AS "path", f.title AS "title",`,
      `  ${singleText(PROJECT_STATUS_KEY)} AS "status",`,
      `  EXISTS (SELECT 1 FROM relations AS r`,
      `    WHERE r.key = '${FILED_UNDER_KEY}' AND r.dst = f.path`,
      `      AND ${inUseOfTypeSql('r.src', '?')}`,
      `      AND ${singleText(TASK_KEYS.status, 'r.src')} IN (${moving})) AS "moving"`,
      `FROM files AS f`,
      `WHERE ${inUseOfTypeSql('f.path', '?')}`,
      `  AND ${paraProjectSql('f.path')}`,
      `ORDER BY f.path`,
    ].join('\n'),
    parameters: [TASK_TYPE, ...MOVING_STATUSES, PROJECT_TYPE],
  };
}

const textOrNull = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * Who a task waits on, from its `waiting_on` items as the statement joined
 * them — a `[[link]]` by what it shows, a plain name as written — as the
 * task rules read them. '' for nobody.
 */
export function waitingOnNames(joined: unknown): string {
  if (typeof joined !== 'string') return '';
  return joined
    .split(ITEM_SEPARATOR)
    .map(shownName)
    .filter((name) => name !== '')
    .join(', ');
}

function shownName(item: string): string {
  return splitWikiLinks(item)
    .map((piece) => (piece.kind === 'text' ? piece.value : wikiLinkLabel(piece)))
    .join('')
    .trim();
}

/** Items as the statement joined them — a task's contexts, its project's link names — each trimmed, blanks left out. */
function itemsOf(joined: unknown): readonly string[] {
  if (typeof joined !== 'string') return [];
  return joined
    .split(ITEM_SEPARATOR)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** A row of {@link compileReviewTasksQuery}, as the review reads it. */
export function reviewTask(row: Readonly<Record<string, unknown>>): ReviewTask {
  const project = textOrNull(row['project']);
  return {
    path: createVaultPath(String(row['path'])),
    title: String(row['title'] ?? ''),
    status: gtdStatusOf(row['status']),
    due: textOrNull(row['due']),
    defer: textOrNull(row['defer']),
    // Absent when the row did not carry it, which is not knowing it: see ReviewTask.
    ...(Object.hasOwn(row, 'recurrence') && { recurrence: textOrNull(row['recurrence']) }),
    waitingOn: waitingOnNames(row['waitingOn']),
    contexts: itemsOf(row['contexts']),
    project: project === null ? null : createVaultPath(project),
    projectTitle: project === null ? null : (textOrNull(row['projectTitle']) ?? project),
    // Absent when the row did not carry it, which is not knowing it: see ReviewTask.
    ...(Object.hasOwn(row, 'projectLinks') && { projectLinks: itemsOf(row['projectLinks']) }),
    modified: Number(row['modified']) || 0,
  };
}

/** A row of {@link compileReviewProjectsQuery}, as the review reads it. */
export function reviewProject(row: Readonly<Record<string, unknown>>): ReviewProject {
  return {
    path: createVaultPath(String(row['path'])),
    title: String(row['title'] ?? ''),
    status: textOrNull(row['status']),
    moving: Number(row['moving']) === 1,
  };
}

/** What the Friday review draft's statements start with (#40). */
export const REVIEW_DONE_QUERY_MARK = '/* weekly review: done */';
export const REVIEW_MEETINGS_QUERY_MARK = '/* weekly review: meetings */';

/** The key a meeting's day is kept under. */
const MEETING_DATE_KEY = 'date';

/** The days and moments a week of wins is counted over, when it is not "since" alone. */
export interface ReviewWeekBounds {
  /** `YYYY-MM-DD`: the first day a task's `completed` may be. */
  readonly sinceDay: string;
  /** Milliseconds since the epoch: a task with no `completed` day must have changed before it. */
  readonly until: number;
  /** `YYYY-MM-DD`: the last day a task's `completed` may be. */
  readonly untilDay: string;
}

/**
 * The tasks finished since `since` (milliseconds since the epoch), asked of
 * the index: in the finished status, and finished in the window — by the
 * day it says it was `completed` when it says one, since filing a task into
 * the Archive or touching it later rewrites it without finishing it again;
 * by when it was last changed only when it says no day. In user space,
 * whether or not it has been moved into the Archive yet. Newest first.
 *
 * Without `bounds` the window has no end and starts at the day `since` falls on.
 */
export function compileReviewDoneQuery(since: number, bounds?: ReviewWeekBounds): CompiledQuery {
  const { sinceDay, until, untilDay } = bounds ?? {
    sinceDay: new Date(since).toISOString().slice(0, 10),
    until: Number.MAX_SAFE_INTEGER,
    untilDay: '9999-12-31',
  };
  return {
    sql: [
      `${REVIEW_DONE_QUERY_MARK} SELECT f.path AS "path", f.title AS "title", f.modified AS "modified"`,
      `FROM files AS f`,
      `WHERE EXISTS (SELECT 1 FROM props AS ty WHERE ty.path = f.path AND ty.key = 'type'`,
      `    AND lower(trim(ty.value_text)) = ?)`,
      `  AND ${userSpaceNoteSql('f.path')}`,
      `  AND ${singleText(TASK_KEYS.status)} = ?`,
      `  AND CASE WHEN ${firstDay(TASK_KEYS.completed)} IS NOT NULL`,
      `    THEN ${firstDay(TASK_KEYS.completed)} BETWEEN ? AND ?`,
      `    ELSE f.modified >= ? AND f.modified < ? END`,
      `ORDER BY f.modified DESC, f.path`,
    ].join('\n'),
    parameters: [TASK_TYPE, FINISHED_TASK_STATUS, sinceDay, untilDay, since, until],
  };
}

/** The meetings held from `sinceDay` to `untilDay` (`YYYY-MM-DD`), asked of the index, by day. */
export function compileReviewMeetingsQuery({
  sinceDay,
  untilDay,
}: {
  sinceDay: string;
  untilDay: string;
}): CompiledQuery {
  return {
    sql: [
      `${REVIEW_MEETINGS_QUERY_MARK} SELECT f.path AS "path", f.title AS "title", ${firstDay(MEETING_DATE_KEY)} AS "date"`,
      `FROM files AS f`,
      `WHERE ${inUseOfTypeSql('f.path', '?')}`,
      `  AND ${firstDay(MEETING_DATE_KEY)} BETWEEN ? AND ?`,
      `ORDER BY "date", f.path`,
    ].join('\n'),
    parameters: [MEETING_TYPE, sinceDay, untilDay],
  };
}

/** A row of {@link compileReviewDoneQuery} or {@link compileReviewMeetingsQuery}. */
export function reviewSource(row: Readonly<Record<string, unknown>>): ReviewSource {
  const date = textOrNull(row['date']);
  return {
    path: createVaultPath(String(row['path'])),
    title: String(row['title'] ?? ''),
    ...(date !== null && { date }),
  };
}
