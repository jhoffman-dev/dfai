/**
 * A filter on a list of text, answered from each note's items in the index
 * rather than from its joined cell (#923).
 *
 * A list's cell is its items' texts joined by `', '` in written order
 * (`joinsTextItems`), and a filter written against the cell builds it for
 * every note of the type: each note's items read, sorted into written order
 * and joined, some 100 steps of SQLite's budget a meeting. These ask, note by
 * note, whether the note holds a matching item, through `props_path` (path,
 * key, value_text) alone: the same notes the cell's filter reads, and never
 * more steps on any of them — a lookup by key across the vault would read
 * every other type's items too (the attack on #929). Each form says why it
 * keeps exactly the notes the cell's filter keeps; where none could, the
 * filter is left to the cell (null).
 *
 * The one difference, deliberate: an item holding a NUL character. LIKE reads
 * a text only up to its first NUL, so the joined cell hides every item after
 * one that holds a NUL from `contains`; item by item, each is read up to its
 * own. YAML writes one only for a `"\0"` escape.
 */

import { listCellSql, joinsTextItems, type TypeViewColumn } from '../query-language/type-view.ts';
import type { FilterOperator } from './view-query.ts';

/** An item of the key in the note `path` names: a row whose text is no blank, as the cell joins. */
const itemsOf = (path: string, selected = '1') =>
  `SELECT ${selected} FROM props AS p WHERE p.path = ${path} AND p.key = ? AND p.value_text <> ''`;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** SQLite's own folding of a name: ASCII letters only. */
const foldedName = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * The column of the type's view a filter's key names, when that column is a
 * list of text: SQLite reads a column name in any case, so `People` names
 * `people`. None when the key could name two columns, or names none.
 */
export function listColumnOf(
  key: string,
  columns: readonly TypeViewColumn[] | undefined,
): TypeViewColumn | null {
  const folded = foldedName(key);
  const named = (columns ?? []).filter(
    (column) => IDENTIFIER.test(column.key) && foldedName(column.key) === folded,
  );
  const column = named.length === 1 ? named[0] : undefined;
  return column !== undefined && joinsTextItems(column) ? column : null;
}

/**
 * Whether a LIKE pattern matches the joined cell only where it matches one
 * item. A match that reaches past an item takes in the `', '` between two:
 * the comma, which a pattern without a comma or a wildcard cannot match, or
 * only the space after it, which then begins the match. LIKE folds the case
 * of ASCII letters alone, so neither character has another case to match.
 */
const matchesWithinAnItem = (pattern: string): boolean =>
  !/[,%_]/.test(pattern) && !pattern.startsWith(' ');

export interface ListFilter {
  readonly column: TypeViewColumn;
  readonly operator: FilterOperator;
  /** The text compared, or undefined for `isEmpty` and `isNotEmpty`. */
  readonly value: string | undefined;
  /** Compare without regard to case, as a tag is (`tagCondition`). */
  readonly ignoreCase?: boolean;
}

/** Where the filter is asked: the type's view (quoted), whose `path` names each note. */
export interface ListFilterSite {
  readonly table: string;
  /** The view's own name, unquoted, as `sqlite_master` holds it. */
  readonly view: string;
}

/**
 * The filter as a lookup of the note's own items, binding the key and then
 * the value; null when no lookup keeps exactly what the cell's filter does.
 */
export function listCondition(
  filter: ListFilter,
  site: ListFilterSite,
  parameters: (string | number)[],
): string | null {
  const lookup = listLookup(filter);
  if (lookup === null) return null;
  parameters.push(filter.column.key, ...(lookup.binds === undefined ? [] : [lookup.binds]));
  return lookup.sql(`${site.table}."path"`);
}

/**
 * Whether the view the index holds was made with this column as a list of
 * text, read from the view's own text — the index rebuilds its views apart
 * from the types a query is compiled with, and keeps the old ones when a
 * rebuild fails, so the types alone cannot say what a cell is. One read of
 * `sqlite_master` a statement, which SQLite makes once.
 */
export function viewJoinsItemsSql(column: TypeViewColumn, site: ListFilterSite): string {
  const cell = `${listCellSql(column.key)} AS "${column.key}"`.replaceAll("'", "''");
  return `(SELECT instr(sql, '${cell}') > 0 FROM sqlite_master WHERE type = 'view' AND name = '${site.view}' COLLATE NOCASE)`;
}

interface Lookup {
  /** The condition, over the note whose path is `path`. */
  readonly sql: (path: string) => string;
  readonly binds?: string;
}

/** The note holds an item of the key that is also `also`; or, `keeps` false, holds none. */
const holding =
  (also: string, keeps = true) =>
  (path: string): string =>
    `${keeps ? '' : 'NOT '}EXISTS (${itemsOf(path)}${also})`;

function listLookup({ operator, value, ignoreCase = false }: ListFilter): Lookup | null {
  // A cell is null or holds an item: the joined text of no items is never ''.
  if (operator === 'isEmpty') return { sql: holding('', false) };
  if (operator === 'isNotEmpty') return { sql: holding('') };
  if (value === undefined) return null;
  switch (operator) {
    case 'contains':
      return matchesWithinAnItem(value)
        ? { sql: holding(" AND p.value_text LIKE '%' || ? || '%'"), binds: value }
        : null;
    case 'is':
    case 'isNot':
      return exactly(value, operator === 'is', ignoreCase);
    default:
      // startsWith would need the first item in written order, which only the
      // table holds: dearer than the cell where most notes match (#929).
      // Greater and less than compare the whole joined text, past its first item.
      return null;
  }
}

/**
 * Two items or more join with `', '`, so a cell equal to text without one is
 * one item, that text: the note's one item, compared as the cell is — `IS`,
 * so a note of no item or of two is not it. NOCASE folds ASCII letters only,
 * so the same holds without regard to case. A cell is never '', and no item is.
 */
function exactly(value: string, keeps: boolean, ignoreCase: boolean): Lookup | null {
  if (value.includes(', ')) return null;
  const collate = ignoreCase ? ' COLLATE NOCASE' : '';
  const only = (path: string) => itemsOf(path, 'CASE WHEN count(*) = 1 THEN max(p.value_text) END');
  return {
    sql: (path) => `(${only(path)}) IS${keeps ? '' : ' NOT'} ?${collate}`,
    binds: value,
  };
}
