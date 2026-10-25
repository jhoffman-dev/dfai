/**
 * Brute-force cosine ranking (ADR-0031): every vector is compared with the
 * query, and the best few are kept. At James's scale — tens of thousands of
 * blocks — that is milliseconds, and an index structure would be one more
 * thing to keep in step with the cache.
 */

/** One vector's place in the list it was ranked from, and how like the query it is. */
export interface Ranked {
  readonly at: number;
  /** Cosine similarity, from -1 to 1. */
  readonly score: number;
}

/** Thrown when two vectors that are compared are not the same length: they are from different models. */
export class VectorLengthError extends Error {
  constructor(expected: number, found: number) {
    super(`a vector of ${found} numbers was compared with one of ${expected}`);
    this.name = 'VectorLengthError';
  }
}

/**
 * Cosine similarity of two unit-length vectors, which is their dot product.
 * The embedding port hands back unit vectors (`EmbeddingPort`), so no length
 * is worked out here.
 */
export function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new VectorLengthError(left.length, right.length);
  // Four sums side by side: about twice as fast as one over 384 numbers, measured,
  // since each no longer waits on the add before it. 50,000 blocks are ranked on every search.
  let first = 0;
  let second = 0;
  let third = 0;
  let fourth = 0;
  const length = left.length;
  let at = 0;
  for (; at + 3 < length; at += 4) {
    first += (left[at] as number) * (right[at] as number);
    second += (left[at + 1] as number) * (right[at + 1] as number);
    third += (left[at + 2] as number) * (right[at + 2] as number);
    fourth += (left[at + 3] as number) * (right[at + 3] as number);
  }
  for (; at < length; at += 1) first += (left[at] as number) * (right[at] as number);
  return first + second + third + fourth;
}

/**
 * The `limit` vectors most like `query`, best first. Those `include` turns
 * away are not compared at all. Two of the same score keep the order they
 * were given in, so the same cache always ranks the same way. A vector whose
 * score is not a finite number is skipped, never ranked.
 */
export function topByCosine({
  query,
  vectors,
  limit,
  include = () => true,
}: {
  query: Float32Array;
  vectors: readonly Float32Array[];
  limit: number;
  include?: (at: number) => boolean;
}): Ranked[] {
  const best: Ranked[] = [];
  if (limit <= 0) return best;
  vectors.forEach((vector, at) => {
    if (!include(at)) return;
    const score = cosine(query, vector);
    // A torn row or a broken model gives NaN, which compares false with everything and would sit first.
    if (!Number.isFinite(score)) return;
    if (best.length === limit && score <= (best[limit - 1] as Ranked).score) return;
    // Placed after every equal score, so an earlier vector stays ahead of a later one.
    let place = best.length;
    while (place > 0 && (best[place - 1] as Ranked).score < score) place -= 1;
    best.splice(place, 0, { at, score });
    if (best.length > limit) best.pop();
  });
  return best;
}
