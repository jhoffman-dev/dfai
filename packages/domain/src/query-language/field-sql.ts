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
  const key = keyed
    ? sql` AND ${fixed(alias)}.key = ${bound(field.key)}${fixed(table === 'props' ? valueRowsSql(field) : '')}`
    : fixed('');
  const from = fixed(`${table} AS ${alias}`);
  if (field.via === null) {
    return sql`FROM ${from}${fixed(join)} WHERE ${fixed(`${alias}.${owner}`)} = n.path${key}`;
  }
  return sql`FROM relations AS h JOIN ${from} ON ${fixed(`${alias}.${owner}`)} = h.dst${fixed(join)} WHERE h.src = n.path AND h.key = ${bound(field.via)} AND ${fixed(HOP_IN_USER_SPACE)}${key}`;
}

const HOP_IN_USER_SPACE = userSpaceNoteSql('h.dst');

/**
 * Which of a note's rows of a property hold its values, as the Today page and
 * the weekly review read them, so a query, a cell and a sort all agree with
 * them (follow-up to #110):
 *
 * - A blank item is no item: `status: [next-action, ""]` holds next-action.
 * - A date field holds the days it can read. A value written as words, `TBD`,
 *   or a day no calendar has, `2026-02-30`, is no date (`firstDay`). One that
 *   holds a single date holds its first real one, so a `due` written as two
 *   days is the first of them. A number field likewise holds only numbers:
 *   `estimate: lots` is no number, as its cell shows none.
 * - Any other field that holds one value holds it only when it is written as
 *   one: `status: [next, done]`, or `[[next, done]]`, is no status
 *   (`singleText`, `gtdStatusOf`).
 * - A field that holds many — a multi-select, tags, links, a relation, and a
 *   note's `type`, which may list several — holds every item written.
 *
 * These are the rows {@link fieldRows} reads. Each rule asks about the row's
 * own note (`p.path`), so it holds through a hop too: `project.due` is each
 * linked project's first day. A field of the note's own that holds one value
 * is read in one subquery instead ({@link ownValueSql}), which is how a
 * condition, a cell and a sort of it cost no more than reading its row.
 */
export function valueRowsSql(field: Pick<QueryField, 'kind' | 'many' | 'valueMany'>): string {
  const kindRows = field.kind === 'date' ? DATED : field.kind === 'number' ? NUMBERED : '';
  if (holdsMany(field)) return `${HELD_ROW}${kindRows}`;
  return `${HELD_ROW}${kindRows} AND ${field.kind === 'date' ? FIRST_DATE : ONLY_ROW}`;
}

/** Whether a field holds several values: every item written is one of them. */
export function holdsMany(field: Pick<QueryField, 'kind' | 'many' | 'valueMany'>): boolean {
  return MANY_KINDS.includes(field.kind) || (field.valueMany ?? field.many);
}

/** Kinds read as several values whatever the property says. */
const MANY_KINDS: readonly FieldKind[] = ['type', 'relation', 'multiSelect'];

/** A row that holds anything: a blank or null item is no item. */
const HELD = "COALESCE(p.value_text, p.value_json, '') <> ''";

const HELD_ROW = ` AND ${HELD}`;

const DATED = ' AND p.value_date IS NOT NULL';

const NUMBERED = ' AND p.value_num IS NOT NULL';

/**
 * No real day before this one. A nested list gives each inner item its outer
 * `idx` (property-value.ts), so rows are told apart by `rowid` within one.
 */
const FIRST_DATE =
  'NOT EXISTS (SELECT 1 FROM props AS q WHERE q.path = p.path AND q.key = p.key AND q.value_date IS NOT NULL AND (q.idx < p.idx OR (q.idx = p.idx AND q.rowid < p.rowid)))';

/** No other item held: a list of two, nested or not, holds no one value. */
const ONLY_ROW =
  "NOT EXISTS (SELECT 1 FROM props AS q WHERE q.path = p.path AND q.key = p.key AND COALESCE(q.value_text, q.value_json, '') <> '' AND q.rowid <> p.rowid)";

/** Whether a field is one value of the note's own, read by {@link ownValueSql}. */
export function isOwnSingle(field: QueryField): boolean {
  return field.via === null && valueTable(field) === 'props' && !holdsMany(field);
}

/**
 * The one value a note holds of a field of its own, as `expression` reads its
 * row, or null when it holds none — by the rules of {@link valueRowsSql}, in
 * one subquery on the note's rows (`props_path`): a date its first real day;
 * anything else its one held item (`singleText`'s count), a number's only
 * when that item is a number.
 */
export function ownValueSql(field: QueryField, expression: string): Fragment {
  const rows = sql`FROM props AS p WHERE p.path = n.path AND p.key = ${bound(field.key)} AND ${fixed(HELD)}`;
  if (field.kind === 'date') {
    return sql`(SELECT ${fixed(expression)} ${rows} AND p.value_date IS NOT NULL ORDER BY p.idx, p.rowid LIMIT 1)`;
  }
  return sql`(SELECT CASE WHEN count(*) = 1 THEN max(${fixed(expression)}) END ${rows})`;
}

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
 * What a field is sorted by: its value — for a relation, the title of the
 * note it first points at, or the link as written when it points nowhere or
 * at a note outside user space, whose title is not the query's to read; for
 * a field that holds many, its first item.
 */
export function sortKeySql(field: QueryField): Fragment {
  if (isOwnSingle(field)) return ownValueSql(field, sortedBy(field));
  if (field.kind === 'relation') {
    const rows = fieldRows(
      field,
      'relations',
      ` LEFT JOIN files AS f ON f.path = r.dst AND ${TARGET_IN_USER_SPACE}`,
    );
    return sql`(SELECT COALESCE(f.title, r.target) ${rows} ORDER BY ${fixed(rowOrder(field, 'relations'))} LIMIT 1)`;
  }
  return sql`(SELECT ${fixed(sortedBy(field))} ${fieldRows(field)} ORDER BY ${fixed(rowOrder(field))} LIMIT 1)`;
}

/** Whether a row holds anything: a blank or null property is no value. */
export function presentValue(field: QueryField): string {
  const table = valueTable(field);
  if (table === 'props') return "COALESCE(p.value_text, p.value_json, '') <> ''";
  return table === 'files' ? `${comparedValue(field)} <> ''` : '1';
}
