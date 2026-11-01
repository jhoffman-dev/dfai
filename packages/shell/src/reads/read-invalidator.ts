import type { Query, QueryClient } from '@tanstack/react-query';
import { INDEX_FACETS, type IndexFacet, type NoteChange } from '@dfai/domain';
import {
  changesTouching,
  READS_ON_INDEX_NEWS,
  scopeTouched,
  type IndexNews,
  type VaultRead,
} from '@dfai/application';
import {
  scopedQueries,
  readAgain,
  readerFailed,
  refreshOfQuery,
  scopeOfQuery,
  vaultQueries,
  vaultReadKey,
} from './query-client.ts';

/**
 * Where the window says which whole-vault reads a change made stale.
 * Rules about which change touches which read are `@dfai/application`'s
 * (`readsTouchedByPaths`, `reportingIndexWrites`); this only applies them.
 */
export interface ReadInvalidator {
  /** Read again now: what they are made from is already on disk. */
  invalidate(vault: string, reads: Iterable<VaultRead>): void;
  /**
   * Read again when the index next has news for its readers (`indexMoved`):
   * the index is part-way through a sync now, and a read of it would be half
   * written. A write outside a sync (a move taken out at once) is followed by
   * the refresh its caller asks for, whose settling is that news.
   */
  invalidateWithIndex(vault: string, reads: Iterable<VaultRead>): void;
  /**
   * What a sync of `vault` found added, changed or removed (P28-03), kept
   * until the index next has news: the scoped reads are judged by it then.
   */
  noteChanges(vault: string, changes: readonly NoteChange[]): void;
  /**
   * The index of `vault` has news: a sync settled having found something, a
   * build finished, or one failed. What waited for it is read again, so are
   * the reads made again on any news (`READS_ON_INDEX_NEWS`), and so is every
   * read of the vault whose last read failed: whatever failed it (a busy
   * disk, a locked index) may have passed. Each scoped read is read again when
   * the notes and facets heard since the last news touched what it is made
   * from (`scopeTouched`, #325) — every one of them when no note was heard,
   * or when `known` is false: a build or a failure, whose notes are not told.
   */
  indexMoved(vault: string, known?: boolean): void;
  /** The reads of the vault waiting for the index's news. */
  waitingFor(vault: string): ReadonlySet<VaultRead>;
  /** Drops the vault's reads, and any still waiting, as it closes. */
  forget(vault: string): void;
}

export function createReadInvalidator({ client }: { client: QueryClient }): ReadInvalidator {
  const waiting = new Map<string, Set<VaultRead>>();
  const heard = new Map<string, NoteChange[]>();
  const invalidate = (vault: string, reads: Iterable<VaultRead>) => {
    for (const read of reads) void readAgain(client, vaultReadKey(vault, read));
  };
  const newsOf = (vault: string, known: boolean): IndexNews => {
    const changes = heard.get(vault) ?? null;
    const held = waiting.get(vault) ?? new Set<VaultRead>();
    const facets = new Set(INDEX_FACETS.filter((facet: IndexFacet) => held.has(facet)));
    return { changes: known ? changes : null, facets };
  };
  /** Each scoped read of `vault` the news touched, or whose last read failed — its own or its reader's. */
  const scopedReadsDue = (vault: string, news: IndexNews) =>
    client.getQueryCache().findAll({
      queryKey: scopedQueries(vault),
      predicate: (query) =>
        query.state.status === 'error' ||
        readerFailed(query.meta) ||
        scopeTouched(scopeOfQuery(query.meta), news),
    });
  /**
   * Whether what a refresh begun at `count` of `query` made may be kept: the
   * query is still the cache's — its vault did not close under it — and no
   * read settled since it began. A whole read that settled meanwhile began
   * after the news, so it holds these changes already, and is newer.
   */
  const stillCurrent = (query: Query, count: number) =>
    client.getQueryCache().get(query.queryHash) === query && query.state.dataUpdateCount === count;
  /** Each refresh of a query waits for the one before it, so none starts from a value the one before it replaces. */
  const refreshing = new Map<string, Promise<void>>();
  const refreshInPlace = (query: Query, changes: readonly NoteChange[]) => {
    const refresh = refreshOfQuery(query.meta);
    const queued = (refreshing.get(query.queryHash) ?? Promise.resolve()).then(async () => {
      const count = query.state.dataUpdateCount;
      try {
        const next =
          query.state.data === undefined ? null : await refresh?.(query.state.data, changes);
        if (!stillCurrent(query, count)) return;
        if (next === null || next === undefined) return await readAgain(client, query.queryKey);
        // A whole read that failed meanwhile bumped no `dataUpdateCount`, so this lands over its
        // error: the refresh built the value from the kept data and these changes, which is
        // right, and the error was only that read's failure to see them.
        client.setQueryData(query.queryKey, next);
      } catch {
        // A refresh that failed falls back to reading the whole again, which shows its own error.
        if (stillCurrent(query, count)) await readAgain(client, query.queryKey);
      }
    });
    refreshing.set(query.queryHash, queued);
    void queued.finally(() => {
      if (refreshing.get(query.queryHash) === queued) refreshing.delete(query.queryHash);
    });
  };
  /** Whether a due read can be brought up to date from the notes that changed, not read whole. */
  const refreshable = (query: Query, news: IndexNews) =>
    news.changes !== null &&
    changesTouching(scopeOfQuery(query.meta), news.changes).length > 0 &&
    query.getObserversCount() > 0 &&
    query.state.status === 'success' &&
    query.state.fetchStatus === 'idle' &&
    !readerFailed(query.meta) &&
    refreshOfQuery(query.meta) !== null;
  return {
    invalidate,
    invalidateWithIndex(vault, reads) {
      const held = waiting.get(vault) ?? new Set<VaultRead>();
      for (const read of reads) held.add(read);
      if (held.size > 0) waiting.set(vault, held);
    },
    noteChanges(vault, changes) {
      if (changes.length > 0) heard.set(vault, [...(heard.get(vault) ?? []), ...changes]);
    },
    indexMoved(vault, known = true) {
      const news = newsOf(vault, known);
      const scoped = scopedReadsDue(vault, news);
      const due = new Set([...(waiting.get(vault) ?? []), ...READS_ON_INDEX_NEWS]);
      waiting.delete(vault);
      heard.delete(vault);
      invalidate(vault, due);
      const failed = client.getQueryCache().findAll({
        queryKey: vaultQueries(vault),
        predicate: (query) => query.state.status === 'error' && !scoped.includes(query),
      });
      for (const query of scoped) {
        if (refreshable(query, news)) {
          refreshInPlace(query, changesTouching(scopeOfQuery(query.meta), news.changes ?? []));
        } else {
          void readAgain(client, query.queryKey);
        }
      }
      for (const query of failed) void readAgain(client, query.queryKey);
    },
    waitingFor: (vault) => new Set(waiting.get(vault)),
    forget(vault) {
      waiting.delete(vault);
      heard.delete(vault);
      client.removeQueries({ queryKey: vaultQueries(vault) });
    },
  };
}
