import { foldedTypeName, foldedTypeSql } from '../types/note-type-sql.ts';
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
 * The `SELECT` behind a type's view, `v_<type>` — the type's table, the
 * sidebar's quick-view counts and dashboard widgets read it — holding each
 * note as a query's cells hold it (follow-up to #110): its notes found by
 * `type` in any case and spacing, and each column the value a `SHOW` of it
 * draws, by the same rules as `valueRowsSql`.
 *
 * It is one grouped pass over the notes' rows, a pivot, with no subquery per
 * cell: a type's table of thousands of notes reads as fast as a pivot of each
 * row's MAX did. TypeScript sends this text and the index (index.rs,
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
    `       COALESCE(MAX(CASE WHEN p.key = 'title' THEN p.value_text END), n.title) AS "title",`,
    '       n.summary AS "summary",',
    `       n.modified AS "modified"${progress}${columns}`,
    // Blank items are no items: left out once, as the rows are joined, not in every cell.
    `FROM files AS n JOIN props AS p ON p.path = n.path AND ${HELD}`,
    `WHERE n.path IN (SELECT path FROM props WHERE key = 'type' AND ${foldedTypeSql('value_text')} = '${foldedTypeName(spec.name)}')`,
    'GROUP BY n.path',
  ].join('\n');
}

/** A row that holds anything: a blank item is no item. */
const HELD = "COALESCE(p.value_text, p.value_json, '') <> ''";

/** A row of the column's key; the join has left out blank items already. */
const heldOf = (key: string) => `p.key = '${key}'`;

/**
 * The row first in written order, as 19 digits that sort by it: `idx`, then
 * `rowid` (a nested list's items share their `idx`). Cheaper than printf,
 * which the pivot would call on every row of the column.
 */
const ORDERED = '(p.idx * 4294967296 + p.rowid + 1000000000000000000)';

/** One column's cell, as the query draws the field (`cellOf`), out of the grouped rows. */
function columnSql(column: TypeViewColumn): string {
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
