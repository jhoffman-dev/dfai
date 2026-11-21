/**
 * A table view, as data.
 *
 * This is what a saved view stores and what the filter and sort controls edit.
 * Compiling it to SQL happens in one place, so the SQL a view runs can always be
 * shown to the person who built it — and edited by hand when the controls are not
 * enough, which is the whole point of using SQL rather than formulas.
 */

import { aggregateFunction, type AggregateKind } from './aggregate.ts';
import { InvalidQueryError } from './invalid-query-error.ts';
import { ATLAS_DIRECTORY } from '../vault/vault-visibility.ts';
import { outsideArchiveSql } from '../archive/archive.ts';
import { PROJECT_TYPE } from '../types/para.ts';
import { outsideParaArchiveSql } from '../types/para-value.ts';
import { foldedLinkName } from '../markdown/resolve-wikilink.ts';
import { linkTargets } from '../index/relation-rows.ts';
import { TAGS_KEY } from '../tags/note-tags.ts';
import { isWikiLink } from '../types/property-value.ts';

export { InvalidQueryError };

export type FilterOperator =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'startsWith'
  | 'greaterThan'
  | 'lessThan'
  | 'isEmpty'
  | 'isNotEmpty';

export const FILTER_OPERATORS: readonly FilterOperator[] = [
  'is',
  'isNot',
  'contains',
  'startsWith',
  'greaterThan',
  'lessThan',
  'isEmpty',
  'isNotEmpty',
];

/** Operators that compare against nothing, so the value is ignored. */
const WITHOUT_VALUE: readonly FilterOperator[] = ['isEmpty', 'isNotEmpty'];

export interface QueryFilter {
  readonly key: string;
  readonly operator: FilterOperator;
  readonly value?: string | number | boolean | null;
}

export interface QuerySort {
  readonly key: string;
  readonly direction: 'asc' | 'desc';
}

export interface ViewQuery {
  /** The object type whose notes this view lists. */
  readonly type: string;
  /** Property keys to show, in order. `path` and `title` are always included. */
  readonly columns: readonly string[];
  readonly filters: readonly QueryFilter[];
  readonly sorts: readonly QuerySort[];
  readonly limit: number;
}

export interface CompiledQuery {
  readonly sql: string;
  readonly parameters: readonly (string | number)[];
}

export const DEFAULT_QUERY_LIMIT = 500;
export const MAX_QUERY_LIMIT = 5000;

/**
 * Dates a filter can ask about without naming one.
 *
 * A view saying "due before tomorrow" has to stay true tomorrow, so the date
 * cannot be written into the file when the view is made. These compile to SQL
 * expressions rather than bound values — they are fixed fragments chosen from
 * this table, never text from a file.
 *
 * A Map rather than an object literal: the lookup is done with a filter value
 * out of a note, and an object would answer for `constructor` and `__proto__`
 * as readily as for `@today`, putting whatever it inherited into the statement
 * instead of binding it.
 */
const RELATIVE_DATES: ReadonlyMap<string, string> = new Map([
  ['@today', "date('now', 'localtime')"],
  ['@yesterday', "date('now', 'localtime', '-1 day')"],
  ['@tomorrow', "date('now', 'localtime', '+1 day')"],
  ['@weekAgo', "date('now', 'localtime', '-7 days')"],
  ['@weekAhead', "date('now', 'localtime', '+7 days')"],
  ['@monthAhead', "date('now', 'localtime', '+1 month')"],
]);

export const RELATIVE_DATE_NAMES: readonly string[] = [...RELATIVE_DATES.keys()];

/** The SQL a relative date compiles to, or null if it is not one. */
export function relativeDateSql(value: unknown): string | null {
  return typeof value === 'string' ? (RELATIVE_DATES.get(value) ?? null) : null;
}

/**
 * Names that may appear in SQL.
 *
 * Values are always bound as parameters, but a column or table name cannot be —
 * it has to go into the text of the statement. Rather than trying to escape
 * whatever arrives, anything that is not a plain identifier is refused.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function identifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new InvalidQueryError(`${what} ${JSON.stringify(name)} is not a usable name`);
  }
  return `"${name}"`;
}

/** The SQL view holding one row per note of a type. */
export function viewNameFor(type: string): string {
  if (!IDENTIFIER.test(type)) {
    throw new InvalidQueryError(`type ${JSON.stringify(type)} is not a usable name`);
  }
  return `v_${type}`;
}

/**
 * What the query should return, when it is not the matching rows themselves.
 *
 * A dashboard asks the same question a table does and draws the answer
 * differently, so it reshapes the SELECT rather than building SQL of its own.
 * Every name still goes through the same check.
 */
export interface QueryShape {
  /** One number over the matching rows. `column` is ignored by `count`. */
  readonly aggregate?: { readonly kind: AggregateKind; readonly column: string | null };
  /** One row per distinct value of this property, with how many notes have it. */
  readonly groupBy?: string;
}

/** The column names a grouped query comes back as. */
export const GROUP_LABEL_COLUMN = 'label';
export const GROUP_COUNT_COLUMN = 'count';

/** The rows a query with this `limit` is compiled to return at most. */
export function queryRowLimit(limit: number): number {
  return Math.min(
    Math.max(1, Math.floor(limit > 0 ? limit : DEFAULT_QUERY_LIMIT)),
    MAX_QUERY_LIMIT,
  );
}

/** Which notes a view reaches besides the ones in use. */
export interface QueryReach {
  /**
   * Archived notes are out of the way unless asked for (U-22): a view over
   * tasks lists the tasks in play, not every task ever finished and put away.
   */
  readonly includeArchived?: boolean;
  /**
   * The note a link's target opens, so `project is [[Larkspur launch]]` keeps
   * every note whose project opens that note, however its link is written:
   * `[[projects/Larkspur launch]]`, `[[larkspur launch]]`, an alias (#212).
   * Without it a link is compared as the text it is.
   */
  readonly resolveLink?: ((target: string) => string | null) | undefined;
}

export function compileViewQuery(
  query: ViewQuery,
  shape: QueryShape = {},
  reach: QueryReach = {},
): CompiledQuery {
  const table = identifier(viewNameFor(query.type), 'type');

  const columns = selection(query, shape);

  const parameters: (string | number)[] = [];
  const conditions = [
    OUTSIDE_ATLAS,
    ...(reach.includeArchived === true ? [] : archivedLeftOut(query.type, table)),
    ...query.filters.map((filter) => condition(filter, parameters, reach)),
  ];

  const order = ordering(query, shape);

  parameters.push(queryRowLimit(query.limit));

  const sql = [
    `SELECT ${[...new Set(columns)].join(', ')}`,
    `FROM ${table}`,
    `WHERE ${conditions.join(' AND ')}`,
    shape.groupBy === undefined ? null : `GROUP BY ${groupExpression(shape.groupBy)}`,
    order.length > 0 ? `ORDER BY ${order.join(', ')}` : null,
    'LIMIT ?',
  ]
    .filter((line) => line !== null)
    .join('\n');

  return { sql, parameters };
}

/**
 * Leaves out the notes DFAI keeps for itself (see `isAtlasNote`): a Task
 * template is `type: task`, and without this it is a card on the board, a row
 * in every task view and one more in every count.
 *
 * Written into the statement rather than bound, because it is a constant of
 * the app and not a value from a note — and so every compiled query keeps the
 * parameters its filters give it. `substr` rather than `LIKE`: LIKE ignores
 * case and treats `_` as a wildcard, and this is an exact prefix.
 */
const ATLAS_PREFIX = `${ATLAS_DIRECTORY}/`;

/** The same condition over any column holding a note's path. */
export function outsideAtlasSql(column: string): string {
  return `substr(${column}, 1, ${ATLAS_PREFIX.length}) <> '${ATLAS_PREFIX}'`;
}

const OUTSIDE_ATLAS = outsideAtlasSql('"path"');

/** Leaves out what is archived, the same way — see `outsideArchiveSql`. */
const OUTSIDE_ARCHIVE = outsideArchiveSql('"path"');

/**
 * The conditions that leave archived notes out of a view over `type`: the
 * Archive folder's, and — over Project notes — the ones whose PARA is
 * archive, which are archived where they stand (#213).
 */
function archivedLeftOut(type: string, table: string): string[] {
  if (type.trim().toLowerCase() !== PROJECT_TYPE) return [OUTSIDE_ARCHIVE];
  return [OUTSIDE_ARCHIVE, outsideParaArchiveSql(`${table}."path"`)];
}

/** A missing property groups under the empty string rather than vanishing. */
function groupExpression(key: string): string {
  return `COALESCE(${identifier(key, 'group column')}, '')`;
}

function selection(query: ViewQuery, shape: QueryShape): string[] {
  if (shape.groupBy !== undefined) {
    return [
      `${groupExpression(shape.groupBy)} AS "${GROUP_LABEL_COLUMN}"`,
      `COUNT(*) AS "${GROUP_COUNT_COLUMN}"`,
    ];
  }

  if (shape.aggregate !== undefined) {
    const { kind, column } = shape.aggregate;
    const expression =
      kind === 'count' || column === null
        ? 'COUNT(*)'
        : `${aggregateFunction(kind)}(${identifier(column, 'aggregate column')})`;
    return [`${expression} AS "value"`];
  }

  // path is what every row is identified by; title is what a person reads.
  return ['"path"', '"title"', ...query.columns.map((key) => identifier(key, 'column'))];
}

function ordering(query: ViewQuery, shape: QueryShape): string[] {
  // The biggest group first, then alphabetically, so a chart reads at a glance.
  if (shape.groupBy !== undefined) {
    return [`"${GROUP_COUNT_COLUMN}" DESC`, `"${GROUP_LABEL_COLUMN}" ASC`];
  }
  if (shape.aggregate !== undefined) return [];

  return [
    // Blank last either way, as the query language's sort puts it (plain
    // SQLite puts NULL first ascending): an empty cell is not the smallest
    // value, only a missing one — a task with no priority comes after P4,
    // not before P1 (#913).
    ...query.sorts.map(
      (sort) =>
        `NULLIF(${identifier(sort.key, 'sort column')}, '') ${sort.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`,
    ),
    // Always last, so two rows that tie never swap places between runs.
    '"path" ASC',
  ];
}

function condition(
  filter: QueryFilter,
  parameters: (string | number)[],
  { resolveLink }: QueryReach,
): string {
  const column = identifier(filter.key, 'filter column');

  if (WITHOUT_VALUE.includes(filter.operator)) {
    return filter.operator === 'isEmpty'
      ? `(${column} IS NULL OR ${column} = '')`
      : `(${column} IS NOT NULL AND ${column} <> '')`;
  }

  const value = filter.value;
  if (value === undefined || value === null) {
    throw new InvalidQueryError(`${filter.operator} needs a value`);
  }

  if (comparesExactly(filter) && typeof value === 'string') {
    if (resolveLink !== undefined && isWikiLink(value)) {
      return relationCondition(filter, value, resolveLink, parameters);
    }
    if (filter.key === TAGS_KEY) return tagCondition(filter, column, value, parameters);
  }

  // A relative date is an expression, not a value, so it takes the place of the
  // placeholder instead of being bound to it.
  const relative = relativeDateSql(value);
  const placeholder = relative ?? '?';
  if (relative === null) {
    parameters.push(typeof value === 'boolean' ? String(value) : value);
  }

  switch (filter.operator) {
    // IS and IS NOT rather than = and <>: they compare null without surprises.
    case 'is':
      return `${column} IS ${placeholder}`;
    case 'isNot':
      return `${column} IS NOT ${placeholder}`;
    case 'contains':
      return `${column} LIKE '%' || ${placeholder} || '%'`;
    case 'startsWith':
      return `${column} LIKE ${placeholder} || '%'`;
    case 'greaterThan':
      return `${column} > ${placeholder}`;
    case 'lessThan':
      return `${column} < ${placeholder}`;
    default:
      throw new InvalidQueryError(`unknown operator ${JSON.stringify(filter.operator)}`);
  }
}

const comparesExactly = (filter: QueryFilter): boolean =>
  filter.operator === 'is' || filter.operator === 'isNot';

/** Whether a view is filtered by a link (`project is [[…]]`), which compiles by the note it opens. */
export function filtersByLink(query: ViewQuery): boolean {
  return query.filters.some((filter) => comparesExactly(filter) && isWikiLink(filter.value ?? ''));
}

/**
 * A link compared by the note it opens, from the index's `relations` table,
 * which keeps where each link a property holds resolves (ADR-0019) — so every
 * way of writing a link to the note is one value. A link to no note matches
 * links written the same way, as a DFAI query's does.
 */
function relationCondition(
  filter: QueryFilter,
  link: string,
  resolveLink: (target: string) => string | null,
  parameters: (string | number)[],
): string {
  const target = linkTargets(link)[0] ?? '';
  const path = resolveLink(target);
  parameters.push(filter.key, path ?? foldedLinkName(target));
  const test = path === null ? 'r.name = ?' : 'r.dst = ?';
  const negated = filter.operator === 'isNot' ? 'NOT ' : '';
  return `${negated}EXISTS (SELECT 1 FROM relations AS r WHERE r.src = "path" AND r.key = ? AND ${test})`;
}

/**
 * A tag compared as tags are: `#Errand` and `errand` are one tag (`tagKey`),
 * so neither its case nor a leading `#` keeps a note out.
 */
function tagCondition(
  filter: QueryFilter,
  column: string,
  tag: string,
  parameters: (string | number)[],
): string {
  parameters.push(tag.trim().replace(/^#/, ''));
  const negated = filter.operator === 'isNot' ? ' NOT' : '';
  return `${column} IS${negated} ? COLLATE NOCASE`;
}
