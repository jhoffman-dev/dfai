import {
  carriesChecklistProgress,
  compileViewQuery,
  foldedTypeName,
  typeViewColumns,
  typeViewSelectSql,
  type ObjectType,
  type TypeViewColumn,
  type ViewQuery,
} from '@dfai/domain';
import type { IndexPort, QueryResult, ViewTypeSpec } from '../index/ports.ts';

export interface ViewResult extends QueryResult {
  /** The SQL that ran, so it can be shown and copied. */
  readonly sql: string;
}

/**
 * Runs a view and reports the SQL it used.
 *
 * The SQL is returned rather than hidden because the point of building on SQL
 * rather than formulas is that you can read what the view actually asked for —
 * and take it somewhere else when the controls run out.
 */
export async function runView({
  index,
  query,
  type = null,
  includeArchived = false,
  resolveLink,
}: {
  index: IndexPort;
  query: ViewQuery;
  /** The type the view lists, so a filter on a list asks for the notes whose items match (`QueryReach`). */
  type?: ObjectType | null;
  /** Lists archived notes too; they are out of the way unless asked for (U-22). */
  includeArchived?: boolean;
  /** The note a link opens, so a filter by a link keeps every link to that note (`QueryReach`). */
  resolveLink?: ((target: string) => string | null) | undefined;
}): Promise<ViewResult> {
  const viewColumns = viewColumnsOf(type === null ? [] : [type], query.type);
  const compiled = compileViewQuery(query, {}, { includeArchived, resolveLink, viewColumns });
  const result = await index.query(compiled.sql, compiled.parameters);
  return { ...result, sql: compiled.sql };
}

/**
 * The columns the index made the view of the type named `typeName` from, as
 * `viewSpecsFor` makes them; undefined when no type is named so, and every
 * filter then compares the view's cell.
 */
export function viewColumnsOf(
  types: readonly ObjectType[],
  typeName: string,
): TypeViewColumn[] | undefined {
  const type = types.find((candidate) => candidate.name === typeName);
  return type === undefined ? undefined : typeViewColumns(type);
}

/**
 * The view the index makes for each type: its `SELECT`, as
 * `typeViewSelectSql` writes it. A type whose name is no identifier has none,
 * nor do two types spelt alike in any case (`Task`, `task`): SQLite names
 * views in any case, so they would ask for one view, and a query naming
 * either is refused by name (check.ts). Every other type keeps its view.
 *
 * A property named like one of the view's own columns — possible in a type
 * file written by hand — is left out rather than given a second column
 * SQLite would rename to `modified:1`. Each note's checklist progress is a
 * column too, unless the type declares a `progress` of its own (P30-03).
 */
export function viewSpecsFor(types: readonly ObjectType[]): ViewTypeSpec[] {
  const spellings = new Map<string, number>();
  for (const type of types) {
    const folded = foldedTypeName(type.name);
    spellings.set(folded, (spellings.get(folded) ?? 0) + 1);
  }
  return types.flatMap((type) => {
    if ((spellings.get(foldedTypeName(type.name)) ?? 0) > 1) return [];
    const select = typeViewSelectSql({
      name: type.name,
      columns: typeViewColumns(type),
      progress: carriesChecklistProgress(type),
    });
    return select === null ? [] : [{ name: type.name, select }];
  });
}
