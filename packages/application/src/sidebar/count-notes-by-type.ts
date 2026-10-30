import {
  compileTypeCountsQuery,
  foldedTypeName,
  TYPE_COUNTS_QUERY_COLUMNS,
  type ObjectType,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';

/**
 * How many notes each type has, for the count beside it in the sidebar.
 *
 * Asked of the index in one statement that hands back only the counts: the
 * index already knows which notes declare which type, and this runs on every
 * refresh, so neither the vault nor every note of every type is read to draw
 * a few numbers (#217). Which notes count is the statement's rule.
 *
 * A type with no notes counts zero. So does every type when the index cannot
 * answer — it is being rebuilt, say — rather than the sidebar failing: the
 * next refresh asks again. Why it could not is handed to `onFailed`.
 */
export async function countNotesByType({
  index,
  types,
  onFailed,
}: {
  index: Pick<IndexPort, 'query'>;
  types: readonly ObjectType[];
  /** Told why the index could not answer, for the log. */
  onFailed?: (cause: unknown) => void;
}): Promise<ReadonlyMap<string, number>> {
  const counts = new Map(types.map((type) => [type.name, 0]));
  if (counts.size === 0) return counts;
  const { sql, parameters } = compileTypeCountsQuery([...counts.keys()]);
  let result;
  try {
    result = await index.query(sql, parameters);
  } catch (cause) {
    // Zero beside each type is what the sidebar showed before the index
    // answered, and the next refresh asks again; why is only for the log.
    onFailed?.(cause);
    return counts;
  }
  const [typeAt = -1, countAt = -1] = TYPE_COUNTS_QUERY_COLUMNS.map((column) =>
    result.columns.indexOf(column),
  );
  // The index counts a type in any case and spacing (foldedTypeSql), so each
  // row is the folded name; it is the count of every type spelt that way.
  const byFolded = new Map<string, number>();
  for (const row of result.rows) {
    const [name, count] = [row[typeAt], row[countAt]];
    if (typeof name === 'string' && typeof count === 'number') byFolded.set(name, count);
  }
  for (const name of counts.keys()) counts.set(name, byFolded.get(foldedTypeName(name)) ?? 0);
  return counts;
}
