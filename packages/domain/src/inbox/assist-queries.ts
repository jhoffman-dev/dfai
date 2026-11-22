/**
 * What Inbox assist asks the index on the press (#906, #907): the open tasks
 * an item may copy, with everything written on them that decides whether a
 * copy can be planned; and the titles a new person's name may clash with.
 */

import { FINISHED_TASK_STATUS, gtdStatusOf, TASK_KEYS, TASK_TYPE } from '../gtd/gtd-status.ts';
import { dueOf } from '../gtd/task-due.ts';
import { firstDaySql, singleTextSql } from '../gtd/task-row.ts';
import type { TaskCandidate } from '../gtd/task-similarity.ts';
import { MEETING_PEOPLE_KEY } from '../meeting-links/meeting-link-keys.ts';
import { foldedPersonName } from '../people/person-match.ts';
import type { CompiledQuery } from '../query/view-query.ts';
import { RECURRENCE_KEY } from '../query/repeating-task.ts';
import { allItems, inUseOfTypeSql, writtenNames } from '../review/review-query.ts';
import { FILED_UNDER_KEY } from '../types/para.ts';
import { createVaultPath } from '../vault/vault-path.ts';

/**
 * What the statements carry right after their SELECT, so a log or a stand-in
 * index can tell them apart; after it, so a guard that reads a statement's
 * first word sees a read.
 */
export const ASSIST_TASKS_QUERY_MARK = '/* inbox assist: tasks */';
export const ASSIST_TITLED_QUERY_MARK = '/* inbox assist: titled */';

/**
 * Every task in use that is not finished, read whole as the weekly review
 * reads its tasks, with each field also as written: a recurrence or a due
 * date written in a form that reads as no one value is still written.
 */
export function compileAssistTasksQuery(): CompiledQuery {
  return {
    sql: [
      `SELECT ${ASSIST_TASKS_QUERY_MARK} f.path AS "path", f.title AS "title",`,
      `  ${singleTextSql(TASK_KEYS.status, 'f.path')} AS "status",`,
      `  ${firstDaySql(TASK_KEYS.due, 'f.path')} AS "due",`,
      `  ${allItems(TASK_KEYS.due)} AS "dueWritten",`,
      `  ${firstDaySql(TASK_KEYS.defer, 'f.path')} AS "defer",`,
      `  ${allItems(TASK_KEYS.defer)} AS "deferWritten",`,
      `  ${allItems(RECURRENCE_KEY)} AS "recurrence",`,
      `  ${allItems(TASK_KEYS.waitingOn)} AS "waitingOn",`,
      `  ${allItems(TASK_KEYS.contexts)} AS "contexts",`,
      `  ${allItems(MEETING_PEOPLE_KEY)} AS "people",`,
      `  (SELECT r.dst FROM relations AS r WHERE r.src = f.path AND r.key = '${FILED_UNDER_KEY}' AND r.dst IS NOT NULL ORDER BY r.idx LIMIT 1) AS "project"`,
      `FROM files AS f`,
      `WHERE ${inUseOfTypeSql('f.path', '?')}`,
      `  AND COALESCE(${singleTextSql(TASK_KEYS.status, 'f.path')}, '') <> ?`,
      `ORDER BY f.path`,
    ].join('\n'),
    parameters: [TASK_TYPE, FINISHED_TASK_STATUS],
  };
}

const written = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** A row of {@link compileAssistTasksQuery}, as the duplicate rule reads it. */
export function assistTaskCandidate(row: Readonly<Record<string, unknown>>): TaskCandidate {
  const day = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  const due = day(row['due']);
  const defer = day(row['defer']);
  const dueItems = written(row['dueWritten'])
    .split('\u001f')
    .filter((item) => item.trim() !== '');
  const dueTime = dueItems.length === 1 ? (dueOf(dueItems[0])?.time ?? null) : null;
  return {
    path: createVaultPath(String(row['path'])),
    title: String(row['title'] ?? ''),
    project: day(row['project']) === null ? null : createVaultPath(String(row['project'])),
    status: gtdStatusOf(row['status']),
    due,
    ...(dueTime !== null && { dueTime }),
    ...(dueItems.length > 1 && { dueMany: true }),
    dueUnread: due === null && written(row['dueWritten']) !== '',
    // A defer written but not a day is still deferred: read as some day, never as none.
    defer: defer ?? (written(row['deferWritten']) === '' ? null : written(row['deferWritten'])),
    recurrence: written(row['recurrence']) === '' ? null : written(row['recurrence']),
    waitingOn: writtenNames(row['waitingOn']).join(', '),
    contexts: writtenNames(row['contexts']),
    people: writtenNames(row['people']),
  };
}

/** The most titles the clash check reads; more is answered "maybe taken", which asks. */
export const ASSIST_TITLES_MAX = 5_000;

/**
 * The titles, of notes of any type, that may fold to one of `names`. SQLite
 * folds only ASCII, so it is asked only for titles whose length allows it —
 * folding drops spaces and marks, so a title is at least as long as the
 * folded name and, decomposed and spaced, at most three times it — and the
 * fold is done by {@link takenTitles}. Read once, at most {@link ASSIST_TITLES_MAX}.
 */
export function compileTitledNotesQuery(names: readonly string[]): CompiledQuery {
  const lengths = names.map((name) => [...foldedPersonName(name)].length);
  const shortest = Math.min(...lengths);
  const longest = Math.max(...lengths) * 3 + 4;
  return {
    sql: `SELECT DISTINCT ${ASSIST_TITLED_QUERY_MARK} files.title AS "title" FROM files WHERE length(files.title) BETWEEN ? AND ? LIMIT ${ASSIST_TITLES_MAX + 1}`,
    parameters: [shortest, longest],
  };
}

/**
 * Which of `names` a title read has, folded as people's names are. When the
 * read was cut short, every name may be taken: a new person is then asked about.
 */
export function takenTitles(
  names: readonly string[],
  titles: readonly string[],
  { cut }: { cut: boolean },
): ReadonlySet<string> {
  if (cut || titles.length > ASSIST_TITLES_MAX) return new Set(names.map(foldedPersonName));
  const folded = new Set(titles.map(foldedPersonName));
  return new Set(names.map(foldedPersonName).filter((name) => folded.has(name)));
}
