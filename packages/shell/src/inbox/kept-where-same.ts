/**
 * `next`, keeping each element of `before` that it holds unchanged — same
 * key, same contents — and `before` itself when nothing changed at all.
 *
 * The Inbox is read again every time the index changes, and every read makes
 * new objects for the same rows. Kept, a row whose note did not change is the
 * same object, so it is not drawn again (#217). Elements are plain data read
 * from the index, so their JSON is what they hold.
 */
export function keptWhereSame<Element>(
  before: readonly Element[] | null,
  next: readonly Element[],
  keyOf: (element: Element) => string,
): readonly Element[] {
  if (before === null) return next;
  const known = new Map(before.map((element) => [keyOf(element), element]));
  const kept = next.map((element) => {
    const was = known.get(keyOf(element));
    return was !== undefined && JSON.stringify(was) === JSON.stringify(element) ? was : element;
  });
  const unchanged =
    kept.length === before.length && kept.every((element, index) => element === before[index]);
  return unchanged ? before : kept;
}
