import { foldedTypeName, foldedTypeSql } from '../types/note-type-sql.ts';
import { outsideArchiveSql } from '../archive/archive.ts';
import { outsideAtlasSql, type CompiledQuery } from '../query/view-query.ts';
import { PROJECT_TYPE } from '../types/para.ts';
import { outsideFirstParaArchiveSql } from '../types/para-value.ts';

/** What {@link compileTypeCountsQuery}'s statement starts with, so a log or a stand-in index can tell it apart. */
export const TYPE_COUNTS_QUERY_MARK = '/* type counts */';

/** The columns {@link compileTypeCountsQuery} comes back as, in order. */
export const TYPE_COUNTS_QUERY_COLUMNS = ['type', 'count'] as const;

/**
 * How many notes each of `typeNames` has, for the count beside it in the
 * sidebar: one row per type that has any, read in one statement rather than
 * every note of every type (#217). A type with none has no row.
 *
 * Counted as a relation offers notes: never one of DFAI's own (a type's
 * template declares the type without being one of its notes), nor one out of
 * the way in the Archive (U-22) or, as a Project, set to PARA archive where it
 * stands (#213) — read from its first `para` value, as the picker reads it.
 * A note declaring a type twice counts once. A type is counted in any case
 * and spacing, as FROM finds it (`foldedTypeSql`): each row names it folded.
 *
 * The names are bound; nothing else in the statement comes from a note.
 * Assumes at least one name: the caller asks nothing of a vault without types.
 */
const FOLDED = foldedTypeSql('typed.value_text');

export function compileTypeCountsQuery(typeNames: readonly string[]): CompiledQuery {
  return {
    sql: [
      `${TYPE_COUNTS_QUERY_MARK} SELECT ${FOLDED} AS "type", COUNT(DISTINCT files.path) AS "count"`,
      `FROM files JOIN props AS typed ON typed.path = files.path`,
      `WHERE typed.key = 'type' AND ${FOLDED} IN (${typeNames.map(() => '?').join(', ')})`,
      `  AND ${outsideAtlasSql('files.path')} AND ${outsideArchiveSql('files.path')}`,
      `  AND (${FOLDED} <> '${PROJECT_TYPE}' OR ${outsideFirstParaArchiveSql('files.path')})`,
      `GROUP BY ${FOLDED}`,
    ].join('\n'),
    parameters: typeNames.map(foldedTypeName),
  };
}
