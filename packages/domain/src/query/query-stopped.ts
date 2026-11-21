/**
 * What either index host answers when a query passes its step budget
 * (`QUERY_STEP_BUDGET` in index.rs and wasm-index-query.ts): SQLite's own word
 * for a statement it was told to stop.
 */
export const QUERY_STOPPED = 'interrupted';

/**
 * What a person reads in its place (#919): what happened, that nothing is
 * lost, and that it is ours to fix. "interrupted" told them none of that. No
 * advice: a filter makes a page cost more, not less, and fewer columns change
 * only the page itself.
 */
export const QUERY_STOPPED_WORDS =
  'DFAI stopped this view because it was taking too long to read. Nothing in your notes is lost. Please report it as a bug.';

/** A failure as words for a person: a stopped query said plainly, anything else as it was said. */
export function failureWords(error: unknown): string {
  const said = error instanceof Error ? error.message : String(error);
  return said.trim() === QUERY_STOPPED ? QUERY_STOPPED_WORDS : said;
}
