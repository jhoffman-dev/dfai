import { foldedTypeName, foldedTypeSql } from '../types/note-type-sql.ts';
import { shownValue, valueRowsSql } from './field-sql.ts';
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
 * draws, read by the same rules ({@link valueRowsSql}).
 *
 * The index builds the view (index.rs, `replace_views`) from the same
 * spec, as this text; `type-view.pin.test.ts` holds the two to one text.
 * Names that are not identifiers are left out, as the index leaves them.
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
    `       COALESCE((SELECT p.value_text FROM props AS p WHERE p.path = n.path AND p.key = 'title' ORDER BY p.idx, p.rowid LIMIT 1), n.title) AS "title",`,
    '       n.summary AS "summary",',
    `       n.modified AS "modified"${progress}${columns}`,
    'FROM files AS n',
    `WHERE n.path IN (SELECT path FROM props WHERE key = 'type' AND ${foldedTypeSql('value_text')} = '${foldedTypeName(spec.name)}')`,
  ].join('\n');
}

/** One column's cell, as `cellOf` draws a field of the note's own. */
function columnSql(column: TypeViewColumn): string {
  const field = asField(column);
  const rows = `FROM props AS p WHERE p.path = n.path AND p.key = '${column.key}'${valueRowsSql(field)}`;
  const value = shownValue(field);
  if (!field.many) return `(SELECT ${value} ${rows} ORDER BY p.idx, p.rowid LIMIT 1)`;
  return `(SELECT group_concat(v, ', ') FROM (SELECT ${value} AS v ${rows} ORDER BY p.idx, p.rowid))`;
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
