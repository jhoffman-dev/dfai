/**
 * A DFAI query as one parameterised, read-only SQL statement over the
 * index's own tables (ADR-0019).
 *
 * Every name and value from the query is bound; the text of the statement is
 * made only of constants of the app. The query is checked first, so a query
 * that compiles is one the vault can answer.
 */

import { outsideArchiveSql } from '../archive/archive.ts';
import { PROJECT_TYPE } from '../types/para.ts';
import { outsideParaArchiveSql } from '../types/para-value.ts';
import { foldedLinkName } from '../markdown/resolve-wikilink.ts';
import { tagKey } from '../tags/tag-name.ts';
import type { ObjectType } from '../types/property-def.ts';
import { userSpaceNoteSql } from '../vault/vault-visibility.ts';
import { DEFAULT_QUERY_LIMIT, queryRowLimit, type CompiledQuery } from '../query/view-query.ts';
import {
  numberText,
  type AtlasQuery,
  type Comparison,
  type Condition,
  type Expression,
  type FieldRef,
  type QueryValue,
  type SortKey,
} from './ast.ts';
import { checkAtlasQuery } from './check.ts';
import {
  comparedValue,
  fieldRows,
  presentValue,
  rowOrder,
  shownValue,
  sortedValue,
} from './field-sql.ts';
import { resolveField, type FieldKind, type QueryField } from './fields.ts';
import { movingDateSql } from './moving-date.ts';
import { bound, fixed, joined, sql, type Fragment } from './sql-fragment.ts';

/** Marks the statement, so it can be told apart in a log or by a stand-in index. */
export const ATLAS_QUERY_MARK = '/* atlas-query */';

/** The columns every result starts with. */
export const LEADING_COLUMNS = ['path', 'title', 'type'] as const;

export interface CompiledAtlasQuery extends CompiledQuery {
  /** The fields after the leading columns, in the order the result holds them. */
  readonly columns: readonly QueryField[];
  /** The fields the rows are grouped by, then sub-grouped by; each is also a column. */
  readonly groups: readonly GroupField[];
}

/** A field the rows are grouped by, and which way its groups run. */
export interface GroupField extends QueryField {
  /** As the query sorts this field, when it does; else ascending. */
  readonly direction: SortKey['direction'];
}

export interface AtlasQueryContext {
  readonly types: readonly ObjectType[];
  /** The note a link names, resolved the way every link in the app is. */
  readonly resolveLink: (target: string) => string | null;
  /** The note the query is shown on, which `this` names; none, and `this` is refused. */
  readonly thisNote?: string | null;
}

export function compileAtlasQuery(
  query: AtlasQuery,
  context: AtlasQueryContext,
): CompiledAtlasQuery {
  checkAtlasQuery(query, context.types, context.thisNote ?? null);
  const from = query.from.map((name) => name.text);
  const field = (ref: FieldRef) => resolveField(ref, context.types, from);
  const grouped = query.group.map(field);
  const columns = resultColumns(query, field, grouped);
  const groups = grouped.map((found) => ({
    ...found,
    direction: directionOf(query, found, field),
  }));

  const statement = sql`${fixed(ATLAS_QUERY_MARK)} SELECT ${selection(columns, from)}
FROM files AS n
WHERE ${conditions(query, field, context)}
ORDER BY ${ordering(query, field)}
LIMIT ${bound(queryRowLimit(query.limit ?? DEFAULT_QUERY_LIMIT))}`;

  return { sql: statement.text, parameters: statement.values, columns, groups };
}

/** Which way a group field's groups run: as the query sorts that field, else ascending. */
function directionOf(
  query: AtlasQuery,
  grouped: QueryField,
  field: (ref: FieldRef) => QueryField,
): SortKey['direction'] {
  const key = query.sort.find((sort) => field(sort.field).text === grouped.text);
  return key?.direction ?? 'asc';
}

/** The columns a result is drawn with after each note's name: its type, then its fields. */
export function resultFields(
  compiled: CompiledAtlasQuery,
): { key: string; label: string; kind: FieldKind }[] {
  return [
    { key: 'type', label: 'Type', kind: 'type' },
    ...compiled.columns.map((field) => ({ key: field.text, label: field.label, kind: field.kind })),
  ];
}

/**
 * What the result shows after its leading columns: what `SHOW` names, or else
 * every field the query mentions — so a filter on `due` shows the due dates.
 * The group fields are always there, since the rows are grouped by them.
 */
function resultColumns(
  query: AtlasQuery,
  field: (ref: FieldRef) => QueryField,
  groups: readonly QueryField[],
): QueryField[] {
  const named =
    query.show.length > 0
      ? query.show
      : [...query.group, ...query.sort.map((key) => key.field), ...mentioned(query.where)];
  const byText = new Map<string, QueryField>();
  for (const found of [...named.map(field), ...groups]) {
    const leading = (LEADING_COLUMNS as readonly string[]).includes(found.text);
    if (!leading && !byText.has(found.text)) byText.set(found.text, found);
  }
  return [...byText.values()];
}

function mentioned(expression: Expression | null): FieldRef[] {
  if (expression === null) return [];
  if (expression.kind === 'linksTo' || expression.kind === 'connectedTo') return [];
  if (expression.kind === 'compare' || expression.kind === 'empty') return [expression.field];
  if (expression.kind === 'not') return mentioned(expression.operand);
  return expression.operands.flatMap(mentioned);
}

function selection(columns: readonly QueryField[], from: readonly string[]): Fragment {
  return joined(
    [
      fixed('n.path AS "path"'),
      fixed('n.title AS "title"'),
      sql`(SELECT t.value_text FROM props AS t WHERE t.path = n.path AND t.key = 'type' AND t.value_text IN (${typeList(from)}) ORDER BY t.idx LIMIT 1) AS "type"`,
      ...columns.map((column) => sql`${cellOf(column)} AS ${fixed(`"${column.text}"`)}`),
    ],
    ', ',
  );
}

function typeList(from: readonly string[]): Fragment {
  return joined(from.map(bound), ', ');
}

/** One value, or several joined as a type's view joins them: `a, b`. */
function cellOf(field: QueryField): Fragment {
  if (field.kind === 'tag') {
    // Each tag once, where it is first written: numbered in row order, then
    // grouped — MIN(a, b, c) of several columns is the smallest of them, not the first row.
    const numbered = sql`SELECT g.name AS name, g.tag AS tag, row_number() OVER (ORDER BY ${fixed(rowOrder(field))}) AS at ${fieldRows(field)}`;
    return sql`(SELECT group_concat(name, ', ') FROM (SELECT '#' || MIN(name) AS name FROM (${numbered}) GROUP BY tag ORDER BY MIN(at)))`;
  }
  const rows = fieldRows(field);
  const order = fixed(rowOrder(field));
  const value = fixed(shownValue(field));
  if (!field.many) return sql`(SELECT ${value} ${rows} ORDER BY ${order} LIMIT 1)`;
  return sql`(SELECT group_concat(v, ', ') FROM (SELECT ${value} AS v ${rows} ORDER BY ${order}))`;
}

/**
 * What leaves archived notes out: the Archive folder, and — from Project
 * notes — the ones whose PARA is archive, archived where they stand (#213).
 */
function archivedLeftOut(from: readonly string[]): Fragment[] {
  const outside = fixed(outsideArchiveSql('n.path'));
  const fromProjects = from.some((name) => name.trim().toLowerCase() === PROJECT_TYPE);
  return fromProjects ? [outside, fixed(outsideParaArchiveSql('n.path'))] : [outside];
}

function conditions(
  query: AtlasQuery,
  field: (ref: FieldRef) => QueryField,
  context: AtlasQueryContext,
): Fragment {
  const from = query.from.map((name) => name.text);
  return joined(
    [
      sql`EXISTS (SELECT 1 FROM props AS t WHERE t.path = n.path AND t.key = 'type' AND t.value_text IN (${typeList(from)}))`,
      fixed(userSpaceNoteSql('n.path')),
      ...(query.includeArchived ? [] : archivedLeftOut(from)),
      ...(query.where === null ? [] : [sql`(${expressionSql(query.where, field, context)})`]),
    ],
    '\n  AND ',
  );
}

function expressionSql(
  expression: Expression,
  field: (ref: FieldRef) => QueryField,
  context: AtlasQueryContext,
): Fragment {
  switch (expression.kind) {
    case 'and':
    case 'or': {
      const parts = expression.operands.map(
        (operand) => sql`(${expressionSql(operand, field, context)})`,
      );
      return balanced(parts, expression.kind === 'and' ? ' AND ' : ' OR ');
    }
    case 'not':
      return sql`NOT (${expressionSql(expression.operand, field, context)})`;
    case 'linksTo':
      return linksToSql(context);
    case 'connectedTo':
      return expression.field === null
        ? connectedToSql(context, 'n.path')
        : reachesConnectedSql(field(expression.field), context);
    default:
      return conditionSql(expression, field(expression.field), context);
  }
}

/**
 * `a OR b OR c OR d` as `(a OR b) OR (c OR d)`: the same answer, but SQLite
 * reads a flat chain as a tree as deep as it is long, and refuses one past
 * 1000 — a long chain of ORs the check lets through must still run.
 */
function balanced(parts: readonly Fragment[], separator: string): Fragment {
  if (parts.length <= 2) return joined(parts, separator);
  const middle = Math.ceil(parts.length / 2);
  const halves = [parts.slice(0, middle), parts.slice(middle)].map(
    (half) => sql`(${balanced(half, separator)})`,
  );
  return joined(halves, separator);
}

/** Whether any of the field's rows matches `test`; with `none`, whether none does. */
function anyRow(rows: Fragment, test: Fragment, none = false): Fragment {
  return sql`${fixed(none ? 'NOT EXISTS' : 'EXISTS')} (SELECT 1 ${rows} AND ${test})`;
}

function conditionSql(
  condition: Extract<Condition, { kind: 'compare' | 'empty' }>,
  field: QueryField,
  context: AtlasQueryContext,
): Fragment {
  if (condition.kind === 'empty') {
    // A multi-valued field is empty when none of its rows holds anything.
    return anyRow(fieldRows(field), fixed(presentValue(field)), !condition.negated);
  }
  const { op, value } = condition;
  if (field.kind === 'tag') return tagCondition(field, op, value);
  if (field.kind === 'checkbox') return checkboxCondition(field, op, value);
  if (field.kind === 'relation') return relationCondition(field, op, value, context);

  const compared = fixed(comparedValue(field));
  const operand = operandOf(field, value);
  // "Is not" means no value is: a note without one is not `done`, so it is listed.
  if (op === '!=') return anyRow(fieldRows(field), sql`${compared} = ${operand}`, true);
  return anyRow(fieldRows(field), comparisonSql(op, compared, operand));
}

function comparisonSql(op: Comparison, left: Fragment, right: Fragment): Fragment {
  switch (op) {
    case 'contains':
      return sql`instr(lower(${left}), lower(${right})) > 0`;
    case 'startsWith':
      return sql`instr(lower(${left}), lower(${right})) = 1`;
    default:
      return sql`${left} ${fixed(op)} ${right}`;
  }
}

/** A value as the right-hand side: a moving date is an expression, anything else is bound. */
function operandOf(field: QueryField, value: QueryValue): Fragment {
  if (value.kind === 'relativeDate') return movingDateSql(value.name) ?? fixed('NULL');
  const raw = valueText(value);
  if (field.kind === 'number' && value.kind === 'number') return bound(value.number);
  // The day as written, as the stored side is read (comparedValue).
  if (field.kind === 'date' || field.kind === 'modified') return sql`substr(${bound(raw)}, 1, 10)`;
  return bound(raw);
}

function valueText(value: QueryValue): string {
  switch (value.kind) {
    case 'number':
      return numberText(value);
    case 'boolean':
      return String(value.value);
    case 'link':
      return value.target;
    case 'tag':
      return value.name;
    case 'relativeDate':
      return `@${value.name}`;
    case 'this':
      return 'this';
    case 'text':
      return value.text;
  }
}

/** The note `this` names. The check refuses `this` without one, so its absence here is a bug. */
function thisNoteOf(context: AtlasQueryContext): string {
  if (context.thisNote === undefined || context.thisNote === null) {
    throw new Error('a query said `this` with no note to name, and was not refused');
  }
  return context.thisNote;
}

/**
 * `LINKS TO this`: a link in the note's body resolves to the note the query is
 * shown on. A note's link to itself is no link to it, as its backlinks say.
 */
function linksToSql(context: AtlasQueryContext): Fragment {
  return sql`EXISTS (SELECT 1 FROM links AS l WHERE l.src = n.path AND l.dst = ${bound(thisNoteOf(context))} AND l.src <> l.dst)`;
}

/**
 * `CONNECTED TO this`: a link joins the note and the note the query is shown
 * on — from either to the other, written in a body (`links`) or held by a
 * property (`relations`, which keeps every link a frontmatter value holds,
 * whatever the property's kind: a task's `source` citing a meeting's line
 * counts). A note is not connected to itself.
 */
function connectedToSql(context: AtlasQueryContext, note: 'n.path' | 'h.dst'): Fragment {
  const page = () => bound(thisNoteOf(context));
  const path = fixed(note);
  const joins = [
    sql`EXISTS (SELECT 1 FROM links AS l WHERE l.src = ${path} AND l.dst = ${page()})`,
    sql`EXISTS (SELECT 1 FROM relations AS r WHERE r.src = ${path} AND r.dst = ${page()})`,
    sql`EXISTS (SELECT 1 FROM links AS l WHERE l.src = ${page()} AND l.dst = ${path})`,
    sql`EXISTS (SELECT 1 FROM relations AS r WHERE r.src = ${page()} AND r.dst = ${path})`,
  ];
  return sql`(${path} <> ${page()} AND (${joined(joins, ' OR ')}))`;
}

/**
 * `waiting_on CONNECTED TO this`: a note the relation points at is connected
 * to the page — a task waiting on someone the company names as an employee,
 * or who names the company as theirs.
 */
function reachesConnectedSql(field: QueryField, context: AtlasQueryContext): Fragment {
  return sql`EXISTS (SELECT 1 FROM relations AS h WHERE h.src = n.path AND h.key = ${bound(field.key)} AND h.dst IS NOT NULL AND ${connectedToSql(context, 'h.dst')})`;
}

/** `tag = #q3` is true of a note tagged #q3 or anything nested under it, like #q3/okr. */
function tagCondition(field: QueryField, op: Comparison, value: QueryValue): Fragment {
  const key = tagKey(valueText(value));
  const nested = `${key}/`;
  const test = sql`(g.tag = ${bound(key)} OR substr(g.tag, 1, length(${bound(nested)})) = ${bound(nested)})`;
  return anyRow(fieldRows(field), test, op === '!=');
}

/** Unticked is anything but `true` — a note that never had the box is not done. */
function checkboxCondition(field: QueryField, op: Comparison, value: QueryValue): Fragment {
  const ticked = value.kind === 'boolean' && value.value;
  return anyRow(fieldRows(field), fixed("p.value_text = 'true'"), (op === '=') !== ticked);
}

/**
 * A relation is compared by the note it points at, resolved when the query
 * runs — or, for `this`, the note the query is shown on; a link to a note that
 * does not exist matches links written the same way. Words in it are searched
 * for in the link's target as written.
 */
function relationCondition(
  field: QueryField,
  op: Comparison,
  value: QueryValue,
  context: AtlasQueryContext,
): Fragment {
  const rows = fieldRows(field, 'relations');
  const target = valueText(value);
  if (op === 'contains' || op === 'startsWith') {
    return anyRow(rows, comparisonSql(op, fixed('r.target'), bound(target)));
  }
  const path = value.kind === 'this' ? thisNoteOf(context) : context.resolveLink(target);
  const test =
    path === null ? sql`r.name = ${bound(foldedLinkName(target))}` : sql`r.dst = ${bound(path)}`;
  return anyRow(rows, test, op === '!=');
}

/** The sorts asked for — blanks last either way — then by title, then by path, so ties never swap. */
function ordering(query: AtlasQuery, field: (ref: FieldRef) => QueryField): Fragment {
  const keys = query.sort.map((key) => {
    const resolved = field(key.field);
    const { rows, value, order } = sortedValue(resolved);
    const first = sql`(SELECT ${fixed(value)} ${rows} ORDER BY ${fixed(order)} LIMIT 1)`;
    const collate = isTextual(resolved) ? ' COLLATE NOCASE' : '';
    const direction = key.direction === 'desc' ? 'DESC' : 'ASC';
    // Blank last, as missing is: IS EMPTY calls both empty, so the sort does too.
    return sql`NULLIF(${first}, '')${fixed(`${collate} ${direction} NULLS LAST`)}`;
  });
  return joined([...keys, fixed('n.title COLLATE NOCASE ASC'), fixed('n.path ASC')], ', ');
}

function isTextual(field: QueryField): boolean {
  return field.kind !== 'number' && field.kind !== 'date' && field.kind !== 'modified';
}
