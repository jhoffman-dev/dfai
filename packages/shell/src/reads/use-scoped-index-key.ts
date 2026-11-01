import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReadScope } from '@dfai/application';
import { indexKeyOf, type IndexStatusStore } from '../index/index-status-store.ts';
import { scopedReadKey, scopedReadMeta } from './query-client.ts';

/**
 * The index's key as a reader made from `scope` sees it (#325): a query of
 * the key, named by the reader, that the index's news reads again only when
 * it touched what the reader is made from (`scopeTouched`). A reader re-run on
 * it reads again for its own data, and not for a note saved anywhere, as one
 * re-run on the window's `indexKey` did.
 *
 * For a reader whose reads are its own to keep — rows that settle on a read
 * made after their write, or the editor's blocks, which ask when it moves.
 * `enabled` false keeps the key where it was, and reads it again once on.
 * `failed` says the reader's last read failed: the key then moves on the
 * index's next news, touched or not, as a failed read of the cache does —
 * whatever failed it (a busy index, a view not yet rebuilt) may have passed.
 */
export function useScopedIndexKey({
  status,
  vault,
  reader,
  scope,
  enabled = true,
  failed = false,
}: {
  status: IndexStatusStore;
  vault: string | null;
  /** Which reader this is: its name and what it reads, for its query's key. */
  reader: readonly unknown[];
  scope: ReadScope;
  enabled?: boolean;
  failed?: boolean;
}): string {
  const query = useQuery({
    ...scopedIndexKeyQuery({ status, vault, reader, scope, failed }),
    enabled: enabled && vault !== null,
  });
  return query.data;
}

/**
 * Whether a reader that keeps its own error said its last read failed, for
 * its scoped key ({@link useScopedIndexKey}'s `failed`): the key is read
 * before the read it moves, so the failure is told after, and drawn once more
 * only when it changes (#424).
 */
export function useLastReadFailed(): readonly [boolean, (error: string | null) => void] {
  const [failed, setFailed] = useState(false);
  const tell = (error: string | null) => {
    if ((error !== null) !== failed) setFailed(error !== null);
  };
  return [failed, tell];
}

/**
 * The query of the index's key as a reader made from `scope` sees it: one
 * definition, for a reader that draws on it ({@link useScopedIndexKey}) and
 * one that only listens (`useScopedIndexNews`).
 */
export function scopedIndexKeyQuery({
  status,
  vault,
  reader,
  scope,
  failed = false,
}: {
  status: IndexStatusStore;
  vault: string | null;
  reader: readonly unknown[];
  scope: ReadScope;
  failed?: boolean;
}) {
  const now = () => indexKeyOf(status.getState(), vault);
  return {
    queryKey: scopedReadKey(vault ?? '', 'index-key', ...reader),
    queryFn: now,
    initialData: now,
    meta: scopedReadMeta(scope, failed),
    // Dropped as soon as no reader holds it: a key is read afresh as one starts
    // to, and keeping one per note a tab ever showed would hold a timer each.
    gcTime: 0,
  };
}
