/*
 * The few things used last, and no more (#505): the EPUB reader keeps the
 * chapters it parsed last this way, so a long book holds a handful of
 * parsed documents, not one for every chapter ever shown or searched.
 */

export interface RecentCache<K, V> {
  /** The value held for `key`, now the one used last; undefined when none is. */
  get(key: K): V | undefined;
  /** Holds `value` for `key`; the one used longest ago goes when there are more than the cache holds. */
  set(key: K, value: V): void;
  delete(key: K): void;
  clear(): void;
  readonly size: number;
}

/** A cache of the `most` values used last. */
export function recentCache<K, V>(most: number): RecentCache<K, V> {
  if (!Number.isInteger(most) || most < 1)
    throw new Error(`a cache holds at least one value, not ${most}`);
  // A Map keeps the order keys were set in: the first is the one used longest ago.
  const held = new Map<K, V>();
  return {
    get(key) {
      if (!held.has(key)) return undefined;
      const value = held.get(key) as V;
      held.delete(key);
      held.set(key, value);
      return value;
    },
    set(key, value) {
      held.delete(key);
      held.set(key, value);
      for (const oldest of held.keys()) {
        if (held.size <= most) break;
        held.delete(oldest);
      }
    },
    delete: (key) => void held.delete(key),
    clear: () => held.clear(),
    get size() {
      return held.size;
    },
  };
}
