import { describe, expect, it } from 'vitest';
import type { CachedBlock } from './ports.ts';
import { relatedByMeaning } from './related-by-meaning.ts';
import type { HeldNote, SemanticBlocks } from './semantic-blocks.ts';

const DIMENSION = 8;
const BLOCKS = 20_000;
const PER_NOTE = 4;

/** A cache of 20k blocks over 5k notes, counting what a look asks of it. */
function bigCache() {
  const counts = { rankable: 0, note: 0, inVault: 0, vectorReads: 0 };
  const blocks: CachedBlock[] = [];
  const vectors: Float32Array[] = [];
  for (let at = 0; at < BLOCKS; at += 1) {
    const vector = new Float32Array(DIMENSION);
    vector[at % DIMENSION] = 1;
    const path = `Notes/N${String(Math.floor(at / PER_NOTE)).padStart(5, '0')}.md`;
    blocks.push({
      path,
      ordinal: at % PER_NOTE,
      digest: `d${at}`,
      anchor: null,
      heading: null,
      vector,
    });
    vectors.push(vector);
  }
  const notes = new Map<string, HeldNote>();
  for (const block of blocks) {
    const held = notes.get(block.path);
    notes.set(block.path, {
      path: block.path,
      title: block.path,
      digest: block.path,
      blocks: [...(held?.blocks ?? []), block],
    } as unknown as HeldNote);
  }
  const rankable = { blocks, vectors, archived: blocks.map(() => false), dimension: DIMENSION };
  const cache = {
    note: (path: string) => {
      counts.note += 1;
      return notes.get(path);
    },
    rankable: () => {
      counts.rankable += 1;
      return rankable;
    },
  } as unknown as SemanticBlocks;
  return { cache, counts };
}

describe('relatedByMeaning over a 20k-block cache', () => {
  it('asks the cache for its blocks once, and each block whether it is in the vault at most once', () => {
    const { cache, counts } = bigCache();
    const answer = relatedByMeaning(
      {
        blocks: cache,
        progress: () => ({ done: 1, total: 1, failure: null }),
        resolve: () => () => null,
        inVault: () => {
          counts.inVault += 1;
          return true;
        },
      },
      { path: 'Notes/N00000.md', exclude: { linked: new Set(), dismissed: new Set() }, limit: 8 },
    );
    expect(answer.notes.length).toBe(8);
    expect(counts.rankable).toBe(1);
    expect(counts.inVault).toBeLessThanOrEqual(BLOCKS);
    // The asked note once, then one title per note offered.
    expect(counts.note).toBeLessThanOrEqual(1 + 8);
  });
});
