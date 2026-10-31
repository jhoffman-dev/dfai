import { notifyManager, QueryClient } from '@tanstack/react-query';
import type { NoteChange } from '@dfai/domain';
import type { ReadScope, VaultRead } from '@dfai/application';

/**
 * The window's one query cache (ADR-0040). A read is made again only when it
 * is invalidated (`staleTime: Infinity`), never because the window regained
 * focus or a component mounted. `networkMode: 'always'`: every read is of
 * this Mac's disk or index, which the browser's idea of being online has
 * nothing to say about. A failed read is shown as failed, not tried again at
 * once: it is read again when the index next has news (`indexMoved`), or
 * when a change touches it, whichever comes first.
 */
export function createWindowQueryClient(): QueryClient {
  notifyManager.setScheduler(inAMessageTask());
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        networkMode: 'always',
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}

/**
 * Runs what the cache tells the window in the next message task, as React's
 * own scheduler does, rather than on a timer as TanStack does by default. A
 * zero-delay timer is time, and where it lands among the host's answers
 * varied from run to run under the work budgets' clock, which counted a tick
 * as 31 commits on one run and 33 on the next; a message task is work, which
 * the clock waits for like React's.
 */
function inAMessageTask(): (callback: () => void) => void {
  const channel = new MessageChannel();
  const due: (() => void)[] = [];
  channel.port1.onmessage = () => {
    for (const callback of due.splice(0)) callback();
  };
  return (callback) => {
    due.push(callback);
    if (due.length === 1) channel.port2.postMessage(null);
  };
}

/** Every query the vault at `vault` holds: its reads begin with this, and are dropped by it. */
export const vaultQueries = (vault: string) => ['vault', vault] as const;

/** One whole-vault read, of one vault: the vault is in the key, so no answer is shown for another. */
export const vaultReadKey = (vault: string, read: VaultRead) =>
  [...vaultQueries(vault), read] as const;

/**
 * A read of one vault made from part of it (#325): a pane's reader, or the
 * window's reader of one type's notes. Under the vault's key, so it is
 * dropped with the vault's reads, and named by what it reads. Its query says
 * what it is made from as `meta` ({@link scopedReadMeta}); the index's news
 * reads it again only when it touched that (`scopeTouched`).
 */
export const scopedReadKey = (vault: string, ...what: readonly unknown[]) =>
  [...vaultQueries(vault), 'scoped', ...what] as const;

/** Every scoped read of the vault at `vault`. */
export const scopedQueries = (vault: string) => [...vaultQueries(vault), 'scoped'] as const;

/**
 * What a scoped read is made from, as its query's `meta` says it, and whether
 * the reader that reads on it said its last read failed (#424): a reader that
 * reads in its own effect keeps its error itself, where the cache cannot see it.
 */
export const scopedReadMeta = (scope: ReadScope, failed = false, refresh?: ReadRefresh) => ({
  scope,
  failed,
  ...(refresh !== undefined && { refresh }),
});

/**
 * How a scoped read of a large list is brought up to date without reading it
 * whole: from what it kept and the changes that touched it, its next value,
 * or null when it has to be read again whole.
 */
export type ReadRefresh = (previous: never, changes: readonly NoteChange[]) => Promise<unknown>;

/** A {@link ReadRefresh} asked of the value its own query holds, which is the type it was written for. */
type KeptRefresh = (previous: unknown, changes: readonly NoteChange[]) => Promise<unknown>;

/** The refresh a scoped read's query was given, if it was given one ({@link scopedReadMeta}). */
export function refreshOfQuery(
  meta: Readonly<Record<string, unknown>> | undefined,
): KeptRefresh | null {
  const refresh = meta?.['refresh'];
  return typeof refresh === 'function' ? (refresh as KeptRefresh) : null;
}

/** Whether the reader of a scoped read said its last read failed ({@link scopedReadMeta}). */
export function readerFailed(meta: Readonly<Record<string, unknown>> | undefined): boolean {
  return meta?.['failed'] === true;
}

/** The scope a scoped read's query was given, or any note for one that said none. */
export function scopeOfQuery(meta: Readonly<Record<string, unknown>> | undefined): ReadScope {
  const scope = meta?.['scope'];
  return typeof scope === 'object' && scope !== null ? (scope as ReadScope) : { anyNote: true };
}

/**
 * Marks a read stale and reads it again if anything shows it. A read already
 * under way may have begun before the change, so it is dropped rather than
 * joined: left alone, a first read still in flight is shared with the ask,
 * and would settle with what was there before.
 */
export async function readAgain(client: QueryClient, queryKey: readonly unknown[]): Promise<void> {
  await client.cancelQueries({ queryKey });
  await client.invalidateQueries({ queryKey });
}
