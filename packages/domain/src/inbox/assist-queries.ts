/**
 * What Inbox assist asks the index on the press (#906, #907), beyond what
 * other features read: whether a note of any type has a name as its title,
 * for the few names a plan may add as new people.
 */

import type { CompiledQuery } from '../query/view-query.ts';

/** What the statement starts with, so a log or a stand-in index can tell it apart. */
export const ASSIST_TITLED_QUERY_MARK = '/* inbox assist: titled */';

/** The notes, of any type, titled as one of `names` (case aside, as SQLite folds it). */
export function compileTitledNotesQuery(names: readonly string[]): CompiledQuery {
  const slots = names.map(() => '?').join(', ');
  return {
    sql: `${ASSIST_TITLED_QUERY_MARK} SELECT files.title AS "title" FROM files WHERE lower(files.title) IN (${slots})`,
    parameters: names.map((name) => name.toLowerCase()),
  };
}
