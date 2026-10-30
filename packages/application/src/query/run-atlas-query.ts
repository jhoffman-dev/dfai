import {
  compileAtlasQuery,
  createVaultPath,
  createWikiLinkResolver,
  parseAtlasQuery,
  problemOf,
  QueryTextError,
  type AtlasQuery,
  type CompiledAtlasQuery,
  type ObjectType,
  type QueryProblem,
} from '@dfai/domain';
import { messageWithoutPaths } from '../api/api-error.ts';
import type { IndexPort } from '../index/ports.ts';
import type { ViewResult } from './run-view.ts';

/**
 * Why a query could not be answered: a problem in its text, pointing at the
 * characters that caused it — or, when the text was fine and the index was
 * not, the index's own words with the machine's paths taken out.
 */
export class AtlasQueryError extends Error {
  readonly problem: QueryProblem | null;

  constructor(message: string, problem: QueryProblem | null) {
    super(message);
    this.name = 'AtlasQueryError';
    this.problem = problem;
  }
}

export interface AtlasQueryAnswer {
  readonly query: AtlasQuery;
  readonly compiled: CompiledAtlasQuery;
  /** The rows, and the SQL that found them, so it can be read and taken elsewhere. */
  readonly result: ViewResult;
}

/**
 * Runs a DFAI query (ADR-0019): read, checked against the vault's types,
 * compiled with its links resolved the way every link in the app is, and run
 * through the index's read-only path.
 */
export async function runAtlasQuery({
  index,
  text,
  types,
  notePaths,
  thisNote = null,
  fetchLimit,
  taskRows = false,
}: {
  index: IndexPort;
  text: string;
  types: readonly ObjectType[];
  /** Every note in the vault, so `[[Julie]]` in the query names the note it means. */
  notePaths: readonly string[];
  /** The note the query is shown on, which `this` names; without one, `this` is refused. */
  thisNote?: string | null;
  /**
   * How many rows to ask the index for, given the LIMIT the text says (null
   * when it says none). Omitted: the text's own LIMIT, or the default. The
   * answer's `query` keeps the text's own LIMIT either way.
   */
  fetchLimit?: (textLimit: number | null) => number;
  /** Whether a query of tasks alone carries each task's state for its row's controls (#107). */
  taskRows?: boolean;
}): Promise<AtlasQueryAnswer> {
  const { query, compiled } = compileText({
    text,
    types,
    notePaths,
    thisNote,
    fetchLimit,
    taskRows,
  });
  try {
    const result = await index.query(compiled.sql, compiled.parameters);
    return { query, compiled, result: { ...result, sql: compiled.sql } };
  } catch (cause) {
    throw new AtlasQueryError(messageWithoutPaths(cause), null);
  }
}

function compileText({
  text,
  types,
  notePaths,
  thisNote,
  fetchLimit,
  taskRows,
}: {
  text: string;
  types: readonly ObjectType[];
  notePaths: readonly string[];
  thisNote: string | null;
  fetchLimit: ((textLimit: number | null) => number) | undefined;
  taskRows: boolean;
}): { query: AtlasQuery; compiled: CompiledAtlasQuery } {
  try {
    const query = parseAtlasQuery(text);
    const resolveLink = createWikiLinkResolver(notePaths.map(createVaultPath));
    const asked = fetchLimit === undefined ? query : { ...query, limit: fetchLimit(query.limit) };
    return {
      query,
      compiled: compileAtlasQuery(asked, { types, resolveLink, thisNote, taskRows }),
    };
  } catch (cause) {
    if (cause instanceof QueryTextError) throw new AtlasQueryError(cause.message, problemOf(cause));
    throw cause;
  }
}
