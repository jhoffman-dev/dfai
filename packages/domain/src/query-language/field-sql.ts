/**
 * Where a field's values live in the index, as SQL.
 *
 * Every field is read the same way: a set of rows — the note's properties,
 * its relations, its tags or its own file row, or those of the note a
 * relation points at — and an expression over each row. A condition asks
 * whether any row matches; a column shows the first row, or all of them.
 * The outer note is always `n`.
 */

import { userSpaceNoteSql } from '../vault/vault-visibility.ts';
import type { FieldKind, QueryField } from './fields.ts';
import { bound, fixed, sql, type Fragment } from './sql-fragment.ts';

/** Which table a field's rows come from. */
export type RowTable = 'props' | 'relations' | 'tags' | 'files';

interface TableShape {
  readonly alias: string;
  /** The column holding the note a row belongs to. */
  readonly owner: string;
  /** The column numbering a row within its note, when rows have an order. */
  readonly order: string | null;
}

const TABLES: Readonly<Record<RowTable, TableShape>> = {
  props: { alias: 'p', owner: 'path', order: 'idx' },
  relations: { alias: 'r', owner: 'src', order: 'idx' },
  tags: { alias: 'g', owner: 'path', order: 'idx' },
  files: { alias: 'f', owner: 'path', order: null },
};

/** The built-ins read from the file's own row rather than its properties. */
const FILE_KINDS: readonly FieldKind[] = ['title', 'path', 'modified', 'progress'];

/** The table a field's values are read from, for showing, sorting or testing emptiness. */
export function valueTable(field: QueryField): RowTable {
  if (field.kind === 'tag') return 'tags';
  return FILE_KINDS.includes(field.kind) ? 'files' : 'props';
}

/**
 * `FROM … WHERE …` over the rows holding a field's values, for one note `n` —
 * or, for `project.owner`, for the notes `n`'s `project` points at. A hop
 * reaches the vault's own notes only: one in `.atlas` or a hidden folder
 * is read as no note at all, so nothing of it can be shown, sorted or tested.
 */
export function fieldRows(
  field: QueryField,
  table: RowTable = valueTable(field),
  /** A constant join onto each row — the note a relation points at. */
  join = '',
): Fragment {
  const { alias, owner } = TABLES[table];
  const keyed = table === 'props' || table === 'relations';
  const key = keyed ? sql` AND ${fixed(alias)}.key = ${bound(field.key)}` : fixed('');
  const from = fixed(`${table} AS ${alias}`);
  if (field.via === null) {
    return sql`FROM ${from}${fixed(join)} WHERE ${fixed(`${alias}.${owner}`)} = n.path${key}`;
  }
  return sql`FROM relations AS h JOIN ${from} ON ${fixed(`${alias}.${owner}`)} = h.dst${fixed(join)} WHERE h.src = n.path AND h.key = ${bound(field.via)} AND ${fixed(HOP_IN_USER_SPACE)}${key}`;
}

const HOP_IN_USER_SPACE = userSpaceNoteSql('h.dst');

/** The order a field's rows are read in: as written, and for a hop, by the link first. */
export function rowOrder(field: QueryField, table: RowTable = valueTable(field)): string {
  const { alias, order } = TABLES[table];
  const own = order === null ? [] : [`${alias}.${order}`];
  return [...(field.via === null ? [] : ['h.idx']), ...own, `${alias}.rowid`].join(', ');
}

/**
 * A row's value as it is compared: numbers as numbers, dates as days — the day
 * as written, since `date()` would move a time with an offset to its UTC day.
 * Every stored date starts with its day (isDateLike).
 */
export function comparedValue(field: QueryField): string {
  switch (field.kind) {
    case 'number':
      return 'p.value_num';
    case 'date':
      return WRITTEN_DAY;
    case 'modified':
      return MODIFIED_DAY;
    case 'title':
      return 'f.title';
    case 'path':
      return 'f.path';
    case 'progress':
      return 'f.progress';
    default:
      return 'p.value_text';
  }
}

/** A row's value as a cell shows it: a date with its time, if it has one. */
export function shownValue(field: QueryField): string {
  return field.kind === 'date' ? 'p.value_date' : comparedValue(field);
}

/** `modified` is kept in milliseconds; a query asks about it by day, in local time. */
const MODIFIED_DAY = "date(f.modified / 1000, 'unixepoch', 'localtime')";

const WRITTEN_DAY = 'substr(p.value_date, 1, 10)';

/**
 * A row's value as it is sorted: to the moment, not the day. A date sorts as
 * written, a space before its time read as the `T` ISO writes.
 */
function sortedBy(field: QueryField): string {
  if (field.kind === 'date') return "replace(p.value_date, ' ', 'T')";
  return field.kind === 'modified' ? 'f.modified' : comparedValue(field);
}

const TARGET_IN_USER_SPACE = userSpaceNoteSql('r.dst');

/**
 * What a field is sorted by: its first value — for a relation, the title of
 * the note it points at, or the link as written when it points nowhere — or
 * at a note outside user space, whose title is not the query's to read.
 */
export function sortedValue(field: QueryField): { rows: Fragment; value: string; order: string } {
  if (field.kind === 'relation') {
    return {
      rows: fieldRows(
        field,
        'relations',
        ` LEFT JOIN files AS f ON f.path = r.dst AND ${TARGET_IN_USER_SPACE}`,
      ),
      value: 'COALESCE(f.title, r.target)',
      order: rowOrder(field, 'relations'),
    };
  }
  return { rows: fieldRows(field), value: sortedBy(field), order: rowOrder(field) };
}

/** Whether a row holds anything: a blank or null property is no value. */
export function presentValue(field: QueryField): string {
  const table = valueTable(field);
  if (table === 'props') return "COALESCE(p.value_text, p.value_json, '') <> ''";
  return table === 'files' ? `${comparedValue(field)} <> ''` : '1';
}
