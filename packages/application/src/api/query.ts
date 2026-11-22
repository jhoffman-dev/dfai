import {
  createVaultPath,
  DEFAULT_QUERY_LIMIT,
  FILTER_OPERATORS,
  InvalidQueryError,
  MAX_QUERY_LIMIT,
  queryRowLimit,
  type FilterOperator,
  type ObjectType,
  type QueryFilter,
  type QuerySort,
  type ViewQuery,
  withChecklistProgress,
} from '@dfai/domain';
import { runView } from '../query/run-view.ts';
import { loadObjectTypes } from '../types/load-types.ts';
import { ApiError, messageWithoutPaths } from './api-error.ts';
import type { ApiRows } from './contract.ts';
import {
  bodyObject,
  countOf,
  isRecord,
  optionalArray,
  optionalBoolean,
  requiredText,
  type Fields,
} from './fields.ts';
import { isApiNotePath } from './paths.ts';
import { checkScheduleAsked, withSchedules } from './task-schedule.ts';
import type { RouteResult, VaultRequest } from './vault-request.ts';

const QUERY_ROWS = { fallback: DEFAULT_QUERY_LIMIT, max: MAX_QUERY_LIMIT };

/**
 * Notes of a type, filtered and sorted, compiled to SQL exactly as a saved
 * view is — with each note's checklist progress as a column, where its type
 * has one (P30-03). A query of tasks with `schedule` gains each task's schedule.
 */
export async function queryRoute(request: VaultRequest): Promise<RouteResult> {
  const fields = bodyObject(request.body);
  const includeArchived = optionalBoolean(fields, 'includeArchived') ?? false;
  const schedule = optionalBoolean(fields, 'schedule') ?? false;
  const query = viewQueryFrom(fields);
  // P30-03 (checklist progress) and P31-01 (schedules) both shape this, in
  // this order: check `schedule` on the query as asked, then add the progress
  // column to it, run it, and add the schedule last — checkScheduleAsked,
  // withChecklistProgress, runViewQuery, withSchedules.
  if (schedule) checkScheduleAsked(query);
  const types = await loadObjectTypes({ fs: request.fs, markdown: request.markdown });
  const type = types.find((candidate) => candidate.name === query.type) ?? null;
  const rows = await runViewQuery(request, withChecklistProgress(query, type), {
    includeArchived,
    type,
  });
  return { status: 200, body: schedule ? await withSchedules(request, rows) : rows };
}

/**
 * Read-only SQL against the index. It runs on the index's read-only connection
 * under its row cap and step budget; anything that connection refuses is
 * `query_failed`, with the database's own reason. The host refuses any
 * statement that is not a read; statements that open, detach or write other
 * database files are refused here too, before they reach it.
 */
export async function sqlRoute(request: VaultRequest): Promise<RouteResult> {
  const fields = bodyObject(request.body);
  const sql = requiredText(fields, 'sql');
  const params = (optionalArray(fields, 'params') ?? []).map((value, at) => {
    if (typeof value === 'string' || typeof value === 'number' || value === null) return value;
    throw new ApiError('invalid', `params[${at}] must be a string, a number or null`);
  });
  const statement = leadingKeyword(sql);
  if (FILE_STATEMENTS.has(statement)) {
    throw new ApiError('invalid', `sql must only read the index, and ${statement} does not`);
  }

  try {
    const result = await request.index.query(sql, params);
    return { status: 200, body: { ...rowsOf(result), sql } };
  } catch (error) {
    throw new ApiError('query_failed', messageWithoutPaths(error));
  }
}

/** Statements that reach files other than the index, even on a read-only connection. */
const FILE_STATEMENTS = new Set(['ATTACH', 'DETACH', 'VACUUM']);

/** The statement's first word, upper-cased, past any whitespace and comments. */
function leadingKeyword(sql: string): string {
  const start = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))*/.exec(sql)?.[0].length ?? 0;
  return (/^[A-Za-z]+/.exec(sql.slice(start))?.[0] ?? '').toUpperCase();
}

/**
 * Runs a view query, telling a query the compiler refuses from one the index
 * could not run.
 *
 * The compiled query already leaves out `.atlas`; notes the API cannot reach
 * are left out again after the index answers, so one more row than the limit
 * is asked for, and the window is widened (up to the row cap) while rows it
 * left out keep the page short: `truncated` then says whether more matched
 * than came back, rather than only whether the host's row cap was reached. A
 * window at the cap that comes back full may hold nothing more for the
 * caller, so it errs towards saying more matched. Archived notes are left
 * out unless `includeArchived` asks for them.
 */
export async function runViewQuery(
  request: VaultRequest,
  query: ViewQuery,
  {
    includeArchived = false,
    type = null,
  }: {
    includeArchived?: boolean;
    /** The type the query lists, so a filter on a list reads only the notes that match (`runView`). */
    type?: ObjectType | null;
  } = {},
): Promise<ApiRows> {
  const limit = queryRowLimit(query.limit);
  try {
    for (let fetched = queryRowLimit(limit + 1); ; fetched = queryRowLimit(fetched * 2)) {
      const result = await runView({
        index: request.index,
        query: { ...query, limit: fetched },
        type,
        includeArchived,
      });
      const rows = userSpaceRows(result);
      const exhausted = !result.truncated && result.rows.length < fetched;
      if (rows.length > limit || exhausted || fetched === MAX_QUERY_LIMIT) {
        return {
          columns: result.columns,
          rows: rows.slice(0, limit),
          truncated: rows.length > limit || !exhausted,
          sql: result.sql,
        };
      }
    }
  } catch (error) {
    if (error instanceof InvalidQueryError) throw new ApiError('invalid', error.message);
    throw new ApiError('query_failed', messageWithoutPaths(error));
  }
}

/**
 * The rows for notes the API could then read: DFAI's own notes in `.atlas` —
 * a Task template is `type: task` too — are left out, as search leaves them out.
 */
function userSpaceRows({ columns, rows }: Omit<ApiRows, 'sql'>): ApiRows['rows'] {
  const at = columns.indexOf('path');
  return rows.filter((row) => {
    const path = row[at];
    return typeof path !== 'string' || isApiNotePath(createVaultPath(path));
  });
}

function rowsOf(result: Omit<ApiRows, 'sql'>): Omit<ApiRows, 'sql'> {
  return { columns: result.columns, rows: result.rows, truncated: result.truncated };
}

function viewQueryFrom(fields: Fields): ViewQuery {
  return {
    type: requiredText(fields, 'type').trim(),
    columns: (optionalArray(fields, 'columns') ?? []).map((column, at) =>
      textAt(column, `columns[${at}]`),
    ),
    filters: (optionalArray(fields, 'filters') ?? []).map((filter, at) =>
      filterFrom(filter, `filters[${at}]`),
    ),
    sorts: (optionalArray(fields, 'sorts') ?? []).map((sort, at) => sortFrom(sort, `sorts[${at}]`)),
    limit: countOf(fields['limit'], { field: 'limit', ...QUERY_ROWS }),
  };
}

function filterFrom(value: unknown, field: string): QueryFilter {
  if (!isRecord(value)) throw new ApiError('invalid', `${field} must be an object`);
  const key = textAt(value['key'], `${field}.key`);
  const operator = textAt(value['operator'], `${field}.operator`) as FilterOperator;
  if (!FILTER_OPERATORS.includes(operator)) {
    throw new ApiError(
      'invalid',
      `${field}.operator must be one of ${FILTER_OPERATORS.join(', ')}`,
    );
  }
  const compared = value['value'];
  if (compared === undefined) return { key, operator };
  if (!isComparable(compared)) {
    throw new ApiError('invalid', `${field}.value must be a string, a number, a boolean or null`);
  }
  return { key, operator, value: compared };
}

function isComparable(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function sortFrom(value: unknown, field: string): QuerySort {
  if (!isRecord(value)) throw new ApiError('invalid', `${field} must be an object`);
  const direction = value['direction'];
  if (direction !== 'asc' && direction !== 'desc') {
    throw new ApiError('invalid', `${field}.direction must be asc or desc`);
  }
  return { key: textAt(value['key'], `${field}.key`), direction };
}

function textAt(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError('invalid', `${field} must be a non-empty string`);
  }
  return value.trim();
}
