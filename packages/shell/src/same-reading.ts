/**
 * Whether two previews read the same: plain data compared by value — arrays,
 * plain objects, Maps and Sets all the way down. An offer read again as the
 * Inbox opens (#130) usually reads just what it did ahead of time, and
 * keeping the earlier value then costs the app no commit at all.
 */
export function sameReading(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && sameItems(a, b);
  }
  if (a instanceof Map || b instanceof Map) {
    return a instanceof Map && b instanceof Map && sameEntries(a, b);
  }
  if (a instanceof Set || b instanceof Set) {
    return (
      a instanceof Set && b instanceof Set && a.size === b.size && [...a].every((x) => b.has(x))
    );
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      sameReading((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** Keeps `was` when `now` reads the same, so a state setter given it changes nothing. */
export function keepIfSame<Value>(was: Value, now: Value): Value {
  return sameReading(was, now) ? was : now;
}

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, at) => sameReading(item, b[at]));
}

function sameEntries(a: ReadonlyMap<unknown, unknown>, b: ReadonlyMap<unknown, unknown>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key) || !sameReading(value, b.get(key))) return false;
  }
  return true;
}
