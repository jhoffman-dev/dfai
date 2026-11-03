import {
  cachedReadBytes,
  cachedReadKey,
  cachedReadOf,
  evictionsToFit,
  fitsInReadCache,
  type CachedReadKind,
} from '@dfai/domain';
import type { Clock } from '../ports.ts';
import type { ReadCacheStore } from './ports.ts';

export interface KeptReadsDeps {
  readonly store: ReadCacheStore;
  readonly clock: Pick<Clock, 'now'>;
  readonly capBytes: number;
  /** Where a failure to keep something is told: the read it was for still answers. */
  readonly report: (error: unknown) => void;
  /**
   * Whose reads these are: the signed-in account and its vault, or null
   * while that is not known, when nothing is kept or answered.
   */
  readonly scope: () => string | null;
}

/**
 * The read cache's bookkeeping (#667): every change to the store goes in
 * call order, one at a time. Keeping is best effort: a store that fails
 * (quota, a private window) costs the offline copy only.
 *
 * What a read or a write answered is kept under the account it was made
 * for. Each is stamped with a ticket as it is asked, and an answer whose
 * ticket is older than the last one kept for that key is dropped: a read
 * begun before a save, answering after it, never lands its older text.
 */
export function keptReads({ store, clock, capBytes, report, scope }: KeptReadsDeps) {
  let chain: Promise<unknown> = Promise.resolve();
  let stopped = false;
  let tickets = 0;
  const newest = new Map<string, number>();
  const inTurn = <T>(change: () => Promise<T>): Promise<T | undefined> => {
    const run = chain.then(() => (stopped ? undefined : change()));
    chain = run.catch(report);
    return run.catch((error: unknown) => {
      report(error);
      return undefined;
    });
  };
  const keyOf = (kind: CachedReadKind, asked: string) => {
    const whose = scope();
    return whose === null ? null : cachedReadKey(whose, kind, asked);
  };

  /** Keeps what a read or write asked at `ticket` answered, unless something asked later was kept. */
  const keep = (kind: CachedReadKind, asked: string, value: unknown, ticket = nextTicket()) => {
    // Stamped as it is asked, not as its turn comes: the order of use is the caller's.
    const usedAt = clock.now();
    const key = keyOf(kind, asked);
    if (key === null || ticket < (newest.get(key) ?? -1)) return Promise.resolve(undefined);
    newest.set(key, ticket);
    return inTurn(async () => {
      const bytes = cachedReadBytes(value);
      if (!fitsInReadCache(bytes, capBytes)) return store.remove([key]);
      await store.put({ key, value, bytes, usedAt });
      const over = evictionsToFit(await store.facts(), capBytes);
      if (over.length > 0) await store.remove(over);
    });
  };
  const nextTicket = () => tickets++;

  /** What was kept, marked used now unless only `peek`ed at. */
  const kept = async (
    kind: CachedReadKind,
    asked: string,
    { peek = false }: { peek?: boolean } = {},
  ): Promise<unknown> => {
    const key = keyOf(kind, asked);
    if (key === null) return undefined;
    const usedAt = clock.now();
    const found = await inTurn(() => store.get(key));
    if (found === null || found === undefined) return undefined;
    if (!peek) void inTurn(() => store.touch(key, usedAt));
    return found.value;
  };

  /** Drops what `matches` of this account's, by kind and what was asked. */
  const forget = (matches: (kind: CachedReadKind, asked: string) => boolean) => {
    const whose = scope();
    return inTurn(async () => {
      const gone = (await store.facts())
        .map((fact) => fact.key)
        .filter((key) => {
          const read = cachedReadOf(key);
          return read.scope === whose && matches(read.kind, read.asked);
        });
      if (gone.length > 0) await store.remove(gone);
    });
  };

  const keysOf = async (kind: CachedReadKind): Promise<readonly string[]> => {
    const whose = scope();
    return ((await inTurn(() => store.facts())) ?? [])
      .map((fact) => cachedReadOf(fact.key))
      .filter((read) => read.scope === whose && read.kind === kind)
      .map((read) => read.asked);
  };

  return {
    keep,
    kept,
    forget,
    keysOf,
    /** A ticket for a read or write about to be asked: what it answers is kept by it. */
    ticket: nextTicket,
    /** Settles once every change asked for so far is done. */
    settled: () => inTurn(async () => undefined),
    /** Changes nothing more: the session is over, and what it kept is about to be cleared. */
    stop: () => {
      stopped = true;
    },
  };
}

export type KeptReads = ReturnType<typeof keptReads>;
