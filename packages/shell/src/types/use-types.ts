import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  loadObjectTypes,
  type DefinedType,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import { readAgain, vaultReadKey } from '../reads/query-client.ts';

const NO_TYPES: readonly DefinedType[] = [];

/**
 * Reads the types again. Settles with them once that read has landed, or with
 * null when it failed or was given up for a later one: what the cache holds
 * then may be from before the change that asked.
 */
export type ReadTypesAgain = () => Promise<readonly DefinedType[] | null>;

/**
 * The vault's type definitions, read once per vault and again when one of
 * them changes (#259). The same answer read twice is the same array, so what
 * hangs off it — the SQL views among them — runs only for a real change.
 * A read that fails is not taken for "no types": it is said (`failure`) and
 * read again when the index next has news.
 */
export function useTypes({
  fs,
  markdown,
  vaultKey,
}: {
  fs: VaultFsPort;
  markdown: MarkdownPort;
  vaultKey: string | null;
}): {
  types: readonly DefinedType[];
  failure: string | null;
  reload: ReadTypesAgain;
} {
  const client = useQueryClient();
  const { data, error } = useQuery({
    queryKey: vaultReadKey(vaultKey ?? '', 'types'),
    queryFn: () => loadObjectTypes({ fs, markdown }),
    enabled: vaultKey !== null,
  });
  const reload = useCallback(async () => {
    const key = vaultReadKey(vaultKey ?? '', 'types');
    // Counted, not timed: a read given up for a later one lands no data.
    const before = client.getQueryState(key)?.dataUpdateCount ?? 0;
    await readAgain(client, key);
    const state = client.getQueryState<DefinedType[]>(key);
    const landed = state !== undefined && state.dataUpdateCount > before;
    return landed && state.fetchStatus === 'idle' ? (state.data ?? null) : null;
  }, [client, vaultKey]);
  const failure =
    vaultKey === null || error === null
      ? null
      : `The types could not be read: ${error instanceof Error ? error.message : String(error)}`;
  return { types: vaultKey === null ? NO_TYPES : (data ?? NO_TYPES), failure, reload };
}
