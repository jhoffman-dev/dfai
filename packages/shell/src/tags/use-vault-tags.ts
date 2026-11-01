import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { rankTagSuggestions, type TagCount, type TagSuggestion } from '@dfai/domain';
import { loadTagCounts, type IndexPort } from '@dfai/application';
import { vaultReadKey } from '../reads/query-client.ts';
import { readState, type ReadState } from '../reads/read-state.ts';

/** The vault's tags as the index has them, or where reading them has got to. */
export type VaultTagsState = ReadState<{ readonly counts: readonly TagCount[] }>;

/**
 * Every tag and how often it is used, read once and shared: the `#`
 * suggestions and the tags page read from the same copy. Read again only when
 * a write to the index changed a tag (#259); read only once the index is
 * ready, as the graph is.
 */
export function useVaultTags({
  index,
  vaultKey,
  ready,
}: {
  index: IndexPort;
  vaultKey: string | null;
  ready: boolean;
}): { state: VaultTagsState; suggest: (query: string) => readonly TagSuggestion[] } {
  const { data, error } = useQuery({
    queryKey: vaultReadKey(vaultKey ?? '', 'tags'),
    queryFn: () => loadTagCounts({ index }),
    enabled: ready && vaultKey !== null,
  });
  const state = useMemo(
    () => readState({ data, error }, 'The tags could not be read', (counts) => ({ counts })),
    [data, error],
  );

  const suggest = useCallback(
    (query: string) => rankTagSuggestions(query, state.kind === 'ready' ? state.counts : []),
    [state],
  );

  return { state, suggest };
}
