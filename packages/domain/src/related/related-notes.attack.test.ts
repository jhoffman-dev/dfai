import { describe, expect, it } from 'vitest';
import { rankRelatedNotes, type RelatableBlock, type RelatedExclusions } from './related-notes.ts';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const PATHS = [
  'Asked.md',
  'Home/Garden.md',
  'Home/Honey.md',
  'Payroll/Wages.md',
  'Elsewhere/Wages.md',
  'Archive/Old.md',
  '.atlas/templates/Meeting.md',
  'Linked.md',
  'Dismissed.md',
  'Zed.md',
] as const;
const DIMENSION = 4;

function unitVector(random: () => number, dimension = DIMENSION): Float32Array {
  // Small integer grid: ties and exact right angles come up often.
  const raw = Array.from({ length: dimension }, () => Math.floor(random() * 5) - 2);
  const length = Math.hypot(...raw);
  return Float32Array.from(raw.map((value) => (length === 0 ? 0 : value / length)));
}

/** A cache: mostly unit vectors, with zero vectors, NaN, ±Infinity and wrong lengths on candidates. */
function cache(random: () => number): RelatableBlock[] {
  const blocks: RelatableBlock[] = [];
  const count = 1 + Math.floor(random() * 30);
  for (let at = 0; at < count; at += 1) {
    const path = PATHS[Math.floor(random() * PATHS.length)] as string;
    const roll = random();
    let vector = unitVector(random);
    if (path !== 'Asked.md') {
      if (roll < 0.05) vector = new Float32Array(DIMENSION);
      else if (roll < 0.1) vector = Float32Array.from([Number.NaN, 0, 0, 0]);
      else if (roll < 0.15) vector = Float32Array.from([Number.POSITIVE_INFINITY, 0, 0, 0]);
      else if (roll < 0.2) vector = unitVector(random, DIMENSION + 1);
    }
    blocks.push({ path, vector });
  }
  return blocks;
}

const EXCLUDED: RelatedExclusions = {
  note: 'Asked.md',
  linked: new Set(['Linked.md']),
  dismissed: new Set(['Dismissed.md']),
};

/** The rule as the PR states it, written plainly. */
function oracle(blocks: readonly RelatableBlock[], limit: number, above = 1e-6) {
  const own = blocks.filter((block) => block.path === 'Asked.md').map((block) => block.vector);
  if (own.length === 0) return [];
  const sum = new Array<number>(DIMENSION).fill(0);
  for (const vector of own) vector.forEach((value, at) => (sum[at] = (sum[at] as number) + value));
  const length = Math.hypot(...sum);
  if (!(length > 0)) return [];
  const centroid = sum.map((value) => value / length);
  const offered = (path: string) =>
    path !== 'Asked.md' &&
    path !== 'Linked.md' &&
    path !== 'Dismissed.md' &&
    !path.startsWith('Archive/') &&
    !path.startsWith('.atlas/');
  const best = new Map<string, number>();
  for (const block of blocks) {
    if (!offered(block.path) || block.vector.length !== DIMENSION) continue;
    let score = 0;
    block.vector.forEach((value, at) => (score += value * (centroid[at] as number)));
    if (!Number.isFinite(score) || score <= above) continue;
    best.set(block.path, Math.max(best.get(block.path) ?? -Infinity, score));
  }
  return [...best]
    .sort(([lp, ls], [rp, rs]) => rs - ls || (lp < rp ? -1 : 1))
    .slice(0, limit)
    .map(([path, score]) => ({ path, score }));
}

const CACHES = (() => {
  const random = seeded(34);
  return Array.from({ length: 3000 }, () => cache(random));
})();

describe('rankRelatedNotes against a plain oracle over seeded caches', () => {
  it('offers the same notes, in the same order, as the rule says', () => {
    const mismatches = CACHES.flatMap((blocks) => {
      const got = rankRelatedNotes({ blocks, excluded: EXCLUDED, limit: 50 }).map((n) => n.path);
      const want = oracle(blocks, 50).map((n) => n.path);
      // Float32 against float64: a score within rounding of 0, or of a neighbour, may go either way.
      const close = oracle(blocks, 50, -1e-5).some(
        ({ score }, at, all) =>
          Math.abs(score) < 1e-5 || Math.abs(score - (all[at + 1]?.score ?? -9)) < 1e-5,
      );
      return close || JSON.stringify(got) === JSON.stringify(want) ? [] : [{ got, want }];
    });
    expect(mismatches.slice(0, 2)).toEqual([]);
  });

  it('gives every offered note a finite score above 0 and at most 1', () => {
    for (const blocks of CACHES)
      for (const { score } of rankRelatedNotes({ blocks, excluded: EXCLUDED, limit: 50 })) {
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThanOrEqual(1 + 1e-6);
      }
  });

  it('offers the same answer whatever order the other notes’ blocks come in', () => {
    const random = seeded(7);
    for (const cached of CACHES.slice(0, 500)) {
      const own = cached.filter((block) => block.path === 'Asked.md');
      const others = cached.filter((block) => block.path !== 'Asked.md');
      const blocks = [...own, ...others];
      const shuffled = [...own, ...[...others].sort(() => random() - 0.5)];
      expect(rankRelatedNotes({ blocks: shuffled, excluded: EXCLUDED })).toEqual(
        rankRelatedNotes({ blocks, excluded: EXCLUDED }),
      );
    }
  });

  it('never offers a note exactly at right angles to the note, rounding aside', () => {
    const unit = (...values: number[]) => {
      const length = Math.hypot(...values);
      return Float32Array.from(values.map((value) => value / length));
    };
    // The centroid of these three is exactly at right angles to Zed's block in real arithmetic.
    const blocks: RelatableBlock[] = [
      { path: 'Asked.md', vector: unit(1, 1, -1, 1) },
      { path: 'Asked.md', vector: unit(2, -2, -2, 1) },
      { path: 'Asked.md', vector: unit(-2, 0, 1, 2) },
      { path: 'Zed.md', vector: unit(-2, -1, -1, 0) },
    ];
    expect(rankRelatedNotes({ blocks, excluded: EXCLUDED })).toEqual([]);
  });

  it('still offers notes when one of the asked note’s blocks has a NaN vector', () => {
    const blocks: RelatableBlock[] = [
      { path: 'Asked.md', vector: Float32Array.from([1, 0, 0, 0]) },
      { path: 'Asked.md', vector: Float32Array.from([Number.NaN, 0, 0, 0]) },
      { path: 'Home/Honey.md', vector: Float32Array.from([1, 0, 0, 0]) },
    ];
    // A candidate's broken block is skipped; the note's own is not, and it hides every suggestion.
    expect(rankRelatedNotes({ blocks, excluded: EXCLUDED }).map((n) => n.path)).toEqual([
      'Home/Honey.md',
    ]);
  });
});
