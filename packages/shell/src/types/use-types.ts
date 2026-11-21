import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  loadTypeListing,
  type BrokenType,
  type DefinedType,
  type TypeListing,
  type MarkdownPort,
  type VaultFsPort,
} from '@dfai/application';
import { ranksTasks, type ObjectType } from '@dfai/domain';
import { readAgain, vaultReadKey } from '../reads/query-client.ts';

/**
 * What `useTypes` hands over while the vault's types are not read yet, or
 * after a read that failed with none read before it: this list itself, never
 * the vault's own empty list, so "not known yet" can be told from "none".
 */
export const TYPES_NOT_READ: readonly DefinedType[] = [];
const NO_TYPES = TYPES_NOT_READ;

/**
 * Whether the vault's tasks are ranked 1 to 4 (`ranksTasks`, #913), as far as
 * the window knows: never while its types are not read, so no pill and no
 * P1–P4 picker shows over a `priority` its Task type may keep as another kind.
 */
export function ranksKnownTasks(types: readonly ObjectType[]): boolean {
  return types !== TYPES_NOT_READ && ranksTasks(types);
}
const NONE_BROKEN: readonly BrokenType[] = [];

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
 * read again when the index next has news. A type file whose frontmatter is
 * not YAML is handed over as `broken`, with why, to be shown with the types (#683).
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
  broken: readonly BrokenType[];
  failure: string | null;
  reload: ReadTypesAgain;
} {
  const client = useQueryClient();
  const { data, error } = useQuery({
    queryKey: vaultReadKey(vaultKey ?? '', 'types'),
    queryFn: () => loadTypeListing({ fs, markdown }),
    enabled: vaultKey !== null,
  });
  const reload = useCallback(async () => {
    const key = vaultReadKey(vaultKey ?? '', 'types');
    // Counted, not timed: a read given up for a later one lands no data.
    const before = client.getQueryState(key)?.dataUpdateCount ?? 0;
    await readAgain(client, key);
    const state = client.getQueryState<TypeListing>(key);
    const landed = state !== undefined && state.dataUpdateCount > before;
    return landed && state.fetchStatus === 'idle' ? (state.data?.types ?? null) : null;
  }, [client, vaultKey]);
  const failure =
    vaultKey === null || error === null
      ? null
      : `The types could not be read: ${error instanceof Error ? error.message : String(error)}`;
  const listing = vaultKey === null ? undefined : data;
  return {
    types: listing?.types ?? NO_TYPES,
    broken: listing?.broken ?? NONE_BROKEN,
    failure,
    reload,
  };
}
