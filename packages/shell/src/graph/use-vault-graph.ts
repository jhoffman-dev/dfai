import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { VaultGraph } from '@dfai/domain';
import { readVaultGraph, type IndexPort } from '@dfai/application';
import { vaultReadKey } from '../reads/query-client.ts';
import { readState, type ReadState } from '../reads/read-state.ts';

/** The vault's graph as the index has it, or where reading it has got to. */
export type VaultGraphState = ReadState<{ readonly graph: VaultGraph }>;

/**
 * Every note and connection, read once and shared: each pane's links and the
 * graph page read from the same copy, so they cannot disagree, and opening a
 * note asks the index nothing more. It is read again only when a write to the
 * index changed a title, a type or a link (#259).
 *
 * Read only once the index is ready — a half-built index would draw half a
 * vault and call it the whole.
 */
export function useVaultGraph({
  index,
  vaultKey,
  ready,
}: {
  index: IndexPort;
  vaultKey: string | null;
  ready: boolean;
}): VaultGraphState {
  const { data, error } = useQuery({
    queryKey: vaultReadKey(vaultKey ?? '', 'graph'),
    queryFn: () => readVaultGraph({ index }),
    enabled: ready && vaultKey !== null,
  });
  // One object per answer, not per render: what reads it is memoised on it.
  return useMemo(
    () => readState({ data, error }, 'The index could not be read', (graph) => ({ graph })),
    [data, error],
  );
}
