/**
 * A filter on a list of text, answered from the list's items in the index
 * rather than from its joined cell (#923).
 *
 * A list's cell is its items' texts joined by `', '` in written order
 * (`joinsTextItems`), and a filter written against the cell builds it for
 * every note of the type before it can keep one: some 200 steps of SQLite's
 * budget a meeting, so a Meeting table filtered by its people stopped near
 * 25,000 meetings. These ask `props` for the notes whose items match, through
 * `props_key` (key, value_text), and keep exactly the notes the cell's filter
 * keeps. Each form below says why it is the same; where it could not be, the
 * filter is left to the cell (null), as a filter with a value no form here
 * takes is.
 */

import { joinsTextItems, type TypeViewColumn } from '../query-language/type-view.ts';
import type { FilterOperator } from './view-query.ts';

/** The notes holding an item of the key, by `props_key`: an item is a row whose text is no blank. */
const ITEMS = "SELECT p.path FROM props AS p WHERE p.key = ? AND p.value_text <> ''";

/** The note holds no other item of the key. */
const ONLY_ITEM =
  "NOT EXISTS (SELECT 1 FROM props AS q WHERE q.path = p.path AND q.key = p.key AND q.value_text <> '' AND q.rowid <> p.rowid)";

/** No item of the key comes before this one in written order (`idx`, then `rowid`, as the cell joins them). */
const FIRST_ITEM =
  "NOT EXISTS (SELECT 1 FROM props AS q WHERE q.path = p.path AND q.key = p.key AND q.value_text <> '' AND (q.idx < p.idx OR (q.idx = p.idx AND q.rowid < p.rowid)))";

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

/**
 * The filter as a lookup of the notes whose items match, binding the key and
 * then the value; null when no lookup keeps exactly what the cell's filter does.
 */
export function listCondition(filter: ListFilter, parameters: (string | number)[]): string | null {
  const lookup = listLookup(filter);
  if (lookup === null) return null;
  parameters.push(filter.column.key, ...(lookup.binds === undefined ? [] : [lookup.binds]));
  return `"path" ${lookup.keeps ? 'IN' : 'NOT IN'} (${ITEMS}${lookup.items})`;
}

interface Lookup {
  /** What the items must also be, after `ITEMS`. */
  readonly items: string;
  readonly binds?: string;
  /** Whether the notes found are the ones kept, or the ones left out. */
  readonly keeps: boolean;
}

function listLookup({ operator, value, ignoreCase = false }: ListFilter): Lookup | null {
  // A cell is null or holds an item: the joined text of no items is never ''.
  if (operator === 'isEmpty') return { items: '', keeps: false };
  if (operator === 'isNotEmpty') return { items: '', keeps: true };
  if (value === undefined) return null;
  switch (operator) {
    case 'contains':
      return matchesWithinAnItem(value)
        ? { items: " AND p.value_text LIKE '%' || ? || '%'", binds: value, keeps: true }
        : null;
    case 'startsWith':
      // The cell begins with its first item, and the match cannot reach past it.
      return matchesWithinAnItem(value)
        ? { items: ` AND p.value_text LIKE ? || '%' AND ${FIRST_ITEM}`, binds: value, keeps: true }
        : null;
    case 'is':
    case 'isNot':
      return exactly(value, operator === 'is', ignoreCase);
    default:
      // Greater and less than compare the whole joined text, past its first item.
      return null;
  }
}

/**
 * Two items or more join with `', '`, so a cell equal to text without one is
 * one item, that text; NOCASE folds ASCII letters only, so the same holds
 * without regard to case. A cell is never '', and no item is.
 */
function exactly(value: string, keeps: boolean, ignoreCase: boolean): Lookup | null {
  if (value.includes(', ')) return null;
  const collate = ignoreCase ? ' COLLATE NOCASE' : '';
  return { items: ` AND p.value_text = ?${collate} AND ${ONLY_ITEM}`, binds: value, keeps };
}
