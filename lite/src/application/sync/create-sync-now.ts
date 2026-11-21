import { RemoteAuthError, RemoteMovedError, RemoteUnreachableError } from '../ports/index.ts';
import { RemoteBranchMissingError, RemoteChangedError } from './errors.ts';
import { pull } from './pull.ts';
import { commitMessage, outgoing, outgoingCount, settlePush } from './push.ts';
import type { SyncConflict, SyncDeps, SyncNow, SyncResult } from './sync-now.ts';

/** How many times a push refused because the branch moved is pulled and tried again. */
export const MAX_SYNC_ATTEMPTS = 3;

/**
 * One round of sync, as `SyncNow`:
 *
 * 1. Pull (see `pull`): read the head, the tree if it is not the one last
 *    seen, and only the blobs that changed; decide each path with the
 *    domain's `decideSync`; apply; record the tree.
 * 2. Push every planned change, the conflict copies, and the derived files
 *    that differ, as one commit on the head just read; never forced.
 * 3. On `RemoteMovedError`, start again from 1, at most
 *    {@link MAX_SYNC_ATTEMPTS} times in all.
 *
 * Any failure leaves what was not pushed dirty here: files are marked clean
 * only after GitHub has accepted the commit.
 */
export function createSyncNow(deps: SyncDeps): SyncNow {
  return async () => {
    const conflicts: SyncConflict[] = [];
    let pulled = 0;
    for (let attempt = 1; ; attempt += 1) {
      let round: Round;
      try {
        round = await syncRound(deps);
      } catch (error) {
        return failed(error);
      }
      pulled += round.pulled;
      conflicts.push(...round.conflicts);
      if (round.kind === 'pushed') return { kind: 'synced', pulled, conflicts, ...round.result };
      if (attempt >= MAX_SYNC_ATTEMPTS) return failed(new RemoteMovedError());
    }
  };
}

type Round = {
  readonly pulled: number;
  readonly conflicts: readonly SyncConflict[];
} & (
  | { readonly kind: 'pushed'; readonly result: { pushed: number; headSha: string | null } }
  | { readonly kind: 'moved' }
);

async function syncRound(deps: SyncDeps): Promise<Round> {
  const pulled = await pull(deps);
  const counts = { pulled: pulled.pulled, conflicts: pulled.conflicts };
  const out = await outgoing(deps, pulled);
  if (outgoingCount(out) === 0)
    return {
      ...counts,
      kind: 'pushed',
      result: { pushed: 0, headSha: pulled.head?.commitSha ?? null },
    };
  try {
    const head = await deps.remote.push({
      message: commitMessage(out),
      upserts: [...out.notes, ...out.derived],
      deletes: [...out.noteDeletes, ...out.derivedDeletes],
      parentCommitSha: pulled.head?.commitSha ?? null,
    });
    await settlePush(deps, { pulled, out, head });
    return {
      ...counts,
      kind: 'pushed',
      result: { pushed: outgoingCount(out), headSha: head.commitSha },
    };
  } catch (error) {
    // What the pull applied stays applied: the next round counts only what is new.
    if (error instanceof RemoteMovedError) return { ...counts, kind: 'moved' };
    throw error;
  }
}

function failed(error: unknown): SyncResult {
  const message = error instanceof Error ? error.message : 'Sync failed.';
  if (error instanceof RemoteAuthError) return { kind: 'failed', reason: 'auth', message };
  if (error instanceof RemoteUnreachableError)
    return { kind: 'failed', reason: 'unreachable', message };
  if (error instanceof RemoteMovedError)
    return {
      kind: 'failed',
      reason: 'moved',
      message: 'The branch kept moving; sync will try again.',
    };
  if (error instanceof RemoteBranchMissingError)
    return { kind: 'failed', reason: 'branch-missing', message };
  if (error instanceof RemoteChangedError)
    return { kind: 'failed', reason: 'remote-changed', message };
  return { kind: 'failed', reason: 'error', message };
}
