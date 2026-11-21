/**
 * What either index host answers when a query passes its step budget
 * (`QUERY_STEP_BUDGET` in index.rs and wasm-index-query.ts): SQLite's own word
 * for a statement it was told to stop.
 */
export const QUERY_STOPPED = 'interrupted';

/**
 * What a person reads in its place (#919): what happened, that nothing is
 * lost, what to try, and that it is ours to fix. "interrupted" told them none
 * of that.
 */
export const QUERY_STOPPED_WORDS =
  'DFAI stopped this view because it was taking too long to read, but nothing in your notes is lost: try showing fewer columns or adding a filter, and please report it as a bug.';

/** A failure as words for a person: a stopped query said plainly, anything else as it was said. */
export function failureWords(error: unknown): string {
  const said = error instanceof Error ? error.message : String(error);
  return said.trim() === QUERY_STOPPED ? QUERY_STOPPED_WORDS : said;
}
