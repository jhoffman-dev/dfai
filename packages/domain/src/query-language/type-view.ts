import { foldedTypeName, foldedTypeSql } from '../types/note-type-sql.ts';
import type { ObjectType } from '../types/property-def.ts';
import { isViewColumn } from '../types/type-name.ts';
import { holdsMany, shownValue } from './field-sql.ts';
import type { FieldKind, QueryField } from './fields.ts';

/** A column of a type's view: a property the type declares. */
export interface TypeViewColumn {
  readonly key: string;
  readonly kind: string;
  readonly many: boolean;
}

/** What a type's view is made from. */
export interface TypeViewSpec {
  readonly name: string;
  readonly columns: readonly TypeViewColumn[];
  readonly progress: boolean;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The columns a type's view is made of: each property it declares, but one
 * named like a column the view has of its own (`isViewColumn`), which SQLite
 * would rename to `modified:1`.
 */
export function typeViewColumns(type: Pick<ObjectType, 'properties'>): TypeViewColumn[] {
  return type.properties
    .filter((property) => !isViewColumn(property.key))
    .map((property) => ({ key: property.key, kind: property.kind, many: property.many }));
}

/**
 * The `SELECT` behind a type's view, `v_<type>` — the type's table, the
 * sidebar's quick-view counts and dashboard widgets read it — holding each
 * note as a query's cells hold it (follow-up to #110): its notes found by
 * `type` in any case and spacing, and each column the value a `SHOW` of it
 * draws, by the same rules as `valueRowsSql`.
 *
 * Each cell is read by its own lookup of its note's rows of its key, through
 * `props_path` (path, key, value_text), not by one grouped pass over every
 * row of every note (#919). A grouped view cannot be flattened into the
 * query that reads it, so the table's `ORDER BY … LIMIT 500` waited for every
 * column of every note to be pivoted first: about 6,600 steps of SQLite's
 * budget per meeting, and the Meeting table stopped at some 750 meetings.
 * Plain cells flatten, so a query pays only for the cells it reads, of the
 * notes it keeps. TypeScript sends this text and the index (index.rs,
 * `replace_views`) only runs it, so the rules live here alone. Names that are
 * not identifiers are left out.
 */
export function typeViewSelectSql(spec: TypeViewSpec): string | null {
  if (!IDENTIFIER.test(spec.name)) return null;
  const progress = spec.progress ? ', n.progress AS "progress"' : '';
  const columns = spec.columns
    .filter((column) => IDENTIFIER.test(column.key))
    .map((column) => `, ${columnSql(column)} AS "${column.key}"`)
    .join('');
  return [
    'SELECT n.path AS "path",',
    `       COALESCE(${cellSql('title', "MAX(CASE WHEN p.key = 'title' THEN p.value_text END)")}, n.title) AS "title",`,
    '       n.summary AS "summary",',
    `       n.modified AS "modified"${progress}${columns}`,
    'FROM files AS n',
    `WHERE n.path IN (SELECT path FROM props WHERE key = 'type' AND ${foldedTypeSql('value_text')} = '${foldedTypeName(spec.name)}')`,
  ].join('\n');
}

/** A row that holds anything: a blank item is no item. */
const HELD = "COALESCE(p.value_text, p.value_json, '') <> ''";

/** A row of the column's key; the lookup has left out blank items already. */
const heldOf = (key: string) => `p.key = '${key}'`;

/**
 * One cell: `aggregate` over the note's rows of `key`, blank items left out,
 * as the grouped pivot read it. Over no rows it is what the pivot's was:
 * count 0, everything else null.
 */
const cellSql = (key: string, aggregate: string, held = HELD) =>
  `(SELECT ${aggregate} FROM props AS p WHERE p.path = n.path AND p.key = '${key}' AND ${held})`;

/**
 * The rows a list of text holds as items: a held row whose text is no blank.
 * A held row with no text (an object item) adds nothing to the joined cell,
 * as `group_concat` passes over null, and a row whose text is blank is not
 * held, so the cell is exactly these rows' texts (#923). Read through
 * `props_path` alone, without each row's `value_json`.
 */
export const LIST_ITEM = "p.value_text <> ''";

/**
 * Whether a column's cell is its items' texts joined by `', '` in written
 * order: a list (`many`, or a multi-select) of a kind shown as its text, so
 * `LIST_ITEM` picks its items.
 */
export function joinsTextItems(column: TypeViewColumn): boolean {
  const field = asField(column);
  return field.many && shownValue(field) === 'p.value_text';
}

/**
 * The row first in written order, as 19 digits that sort by it: `idx`, then
 * `rowid` (a nested list's items share their `idx`). Cheaper than printf,
 * which the pivot would call on every row of the column.
 */
const ORDERED = '(p.idx * 4294967296 + p.rowid + 1000000000000000000)';

/** One column's cell, as the query draws the field (`cellOf`), out of its note's rows. */
function columnSql(column: TypeViewColumn): string {
  if (joinsTextItems(column))
    return cellSql(
      column.key,
      "group_concat(p.value_text, ', ' ORDER BY p.idx, p.rowid)",
      LIST_ITEM,
    );
  return cellSql(column.key, columnAggregate(column));
}

/** How a column's cell is made of its rows, by the same rules as `valueRowsSql`. */
function columnAggregate(column: TypeViewColumn): string {
  const field = asField(column);
  const held = heldOf(column.key);
  const value = shownValue(field);
  if (field.many)
    return `group_concat(CASE WHEN ${held} THEN ${value} END, ', ' ORDER BY p.idx, p.rowid)`;
  if (holdsMany(field) || field.kind === 'date') {
    // The first held item (a date's first real day): the least written-order key, its value after it.
    const dated = field.kind === 'date' ? ' AND p.value_date IS NOT NULL' : '';
    return `substr(min(CASE WHEN ${held}${dated} THEN ${ORDERED} || ${value} END), 20)`;
  }
  // One value only when one item is held, as singleText counts.
  return `CASE WHEN count(CASE WHEN ${held} THEN 1 END) = 1 THEN max(CASE WHEN ${held} THEN ${value} END) END`;
}

/** A column as the field a query names, of the kinds a view is made of. */
function asField(column: TypeViewColumn): QueryField {
  const kind = column.kind as FieldKind;
  return {
    text: column.key,
    label: column.key,
    via: null,
    key: column.key,
    kind,
    options: [],
    target: null,
    many: column.many || kind === 'multiSelect',
  };
}
