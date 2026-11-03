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
}

/**
 * The read cache's bookkeeping (#667): every change to the store goes in
 * call order, one at a time, so a read that finished before a write can
 * never land its older answer over the write's. Keeping is best effort: a
 * store that fails (quota, a private window) costs the offline copy only.
 */
export function keptReads({ store, clock, capBytes, report }: KeptReadsDeps) {
  let chain: Promise<unknown> = Promise.resolve();
  let stopped = false;
  const inTurn = <T>(change: () => Promise<T>): Promise<T | undefined> => {
    const run = chain.then(() => (stopped ? undefined : change()));
    chain = run.catch(report);
    return run.catch((error: unknown) => {
      report(error);
      return undefined;
    });
  };

  // Each change is stamped as it is asked for, not as its turn comes: the order of use is the caller's.
  const keep = (kind: CachedReadKind, asked: string, value: unknown) => {
    const usedAt = clock.now();
    return inTurn(async () => {
      const key = cachedReadKey(kind, asked);
      const bytes = cachedReadBytes(value);
      if (!fitsInReadCache(bytes, capBytes)) return store.remove([key]);
      await store.put({ key, value, bytes, usedAt });
      const over = evictionsToFit(await store.facts(), capBytes);
      if (over.length > 0) await store.remove(over);
    });
  };

  /** What was kept, marked used now unless only `peek`ed at. */
  const kept = async (
    kind: CachedReadKind,
    asked: string,
    { peek = false }: { peek?: boolean } = {},
  ): Promise<unknown> => {
    const key = cachedReadKey(kind, asked);
    const usedAt = clock.now();
    const found = await inTurn(() => store.get(key));
    if (found === null || found === undefined) return undefined;
    if (!peek) void inTurn(() => store.touch(key, usedAt));
    return found.value;
  };

  /** Drops what `matches`, by kind and what was asked. */
  const forget = (matches: (kind: CachedReadKind, asked: string) => boolean) =>
    inTurn(async () => {
      const keys = (await store.facts()).map((fact) => fact.key);
      const gone = keys.filter((key) => {
        const { kind, asked } = cachedReadOf(key);
        return matches(kind, asked);
      });
      if (gone.length > 0) await store.remove(gone);
    });

  const keysOf = async (kind: CachedReadKind): Promise<readonly string[]> =>
    ((await inTurn(() => store.facts())) ?? [])
      .map((fact) => cachedReadOf(fact.key))
      .filter((read) => read.kind === kind)
      .map((read) => read.asked);

  return {
    keep,
    kept,
    forget,
    keysOf,
    /** Settles once every change asked for so far is done. */
    settled: () => inTurn(async () => undefined),
    /** Changes nothing more: the session is over, and what it kept is about to be cleared. */
    stop: () => {
      stopped = true;
    },
  };
}

export type KeptReads = ReturnType<typeof keptReads>;
