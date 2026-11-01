import type { UseQueryResult } from '@tanstack/react-query';

/** A whole-vault read as a page shows it: still coming, failed with a message, or ready. */
export type ReadState<Ready extends object> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | ({ readonly kind: 'ready' } & Ready);

/**
 * A query's state in those terms. A read that failed after one that worked
 * shows the failure, as the pages did before they were queries.
 */
export function readState<Data, Ready extends object>(
  query: Pick<UseQueryResult<Data>, 'data' | 'error'>,
  failure: string,
  ready: (data: Data) => Ready,
): ReadState<Ready> {
  if (query.error !== null) {
    const { error } = query;
    return {
      kind: 'failed',
      message: `${failure}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (query.data === undefined) return { kind: 'loading' };
  return { kind: 'ready', ...ready(query.data) };
}
