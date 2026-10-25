import { isArchivedPath } from '@dfai/domain';
import type { CachedBlock, CachedEmbeddings, CachedNote } from './ports.ts';

/** A note as the window holds it of the cache: its digest and title, and its blocks in order. */
export interface HeldNote extends CachedNote {
  readonly blocks: readonly CachedBlock[];
}

/** The blocks that have vectors, side by side, as a search ranks them. */
export interface RankableBlocks {
  readonly blocks: readonly CachedBlock[];
  readonly vectors: readonly Float32Array[];
  /** Per block: it is in the Archive, worked out once per change rather than once per search. */
  readonly archived: readonly boolean[];
  /** How many numbers each vector has; null while there are none. */
  readonly dimension: number | null;
}

/**
 * The window's copy of the embeddings cache: what a search ranks, and what
 * the build reuses vectors from, so a block whose digest is unchanged is
 * never sent to the model again. It changes only as the build writes the
 * cache, so the two never disagree.
 */
export interface SemanticBlocks {
  /** Each note held, by path, to the digest of the text it was cut from. */
  digests(): Map<string, string>;
  note(path: string): HeldNote | undefined;
  /**
   * The vector of a passage by its digest, wherever it is held — or was held
   * lately, so a note moved to another folder is not embedded again: null when
   * the model would not read it, undefined when it is not known.
   */
  vectorOf(digest: string): Float32Array | null | undefined;
  put(note: HeldNote): void;
  remove(path: string): void;
  /** Every block with a vector, in path order then each note's: the same cache, the same order. */
  rankable(): RankableBlocks;
}

/** A vector of another length than the others is held: the cache is not one model's. */
export class MixedVectorsError extends Error {
  constructor(expected: number, found: number) {
    super(`vectors of ${expected} and ${found} numbers are held together`);
    this.name = 'MixedVectorsError';
  }
}

/**
 * How many passages' vectors are kept after their last block is gone: enough
 * for a folder of notes moved (a removal is heard, and written, before the
 * additions that follow it), small enough to be a few MB.
 */
const RETIRED_VECTORS = 4_096;

const byCodeUnit = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export function createSemanticBlocks(cached: CachedEmbeddings): SemanticBlocks {
  const notes = new Map<string, HeldNote>();
  const blocksOf = new Map<string, CachedBlock[]>();
  for (const block of cached.blocks) {
    const list = blocksOf.get(block.path) ?? [];
    list.push(block);
    blocksOf.set(block.path, list);
  }

  // Passages by digest: how many blocks hold each, and its vector.
  const live = new Map<string, { vector: Float32Array | null; count: number }>();
  const retired = new Map<string, Float32Array | null>();
  let dimension: number | null = null;
  // Worked out again only after a change: a search over an unchanged cache reuses it.
  let rankable: RankableBlocks | null = null;

  const hold = (block: CachedBlock) => {
    if (block.vector !== null) {
      dimension ??= block.vector.length;
      if (block.vector.length !== dimension)
        throw new MixedVectorsError(dimension, block.vector.length);
    }
    const held = live.get(block.digest);
    if (held !== undefined) held.count += 1;
    else {
      live.set(block.digest, { vector: block.vector, count: 1 });
      retired.delete(block.digest);
    }
  };
  const release = (block: CachedBlock) => {
    const held = live.get(block.digest);
    if (held === undefined) return;
    held.count -= 1;
    if (held.count > 0) return;
    live.delete(block.digest);
    retired.set(block.digest, held.vector);
    if (retired.size > RETIRED_VECTORS) retired.delete(retired.keys().next().value as string);
  };

  for (const note of cached.notes) {
    const held: HeldNote = { ...note, blocks: blocksOf.get(note.path) ?? [] };
    held.blocks.forEach(hold);
    notes.set(note.path, held);
  }

  return {
    digests: () => new Map([...notes].map(([path, note]) => [path, note.digest])),
    note: (path) => notes.get(path),
    vectorOf: (digest) => (live.has(digest) ? live.get(digest)?.vector : retired.get(digest)),
    put(note) {
      // Checked before anything changes: a note with a vector of the wrong length is not held half way.
      const expected =
        dimension ?? note.blocks.find((block) => block.vector !== null)?.vector?.length;
      for (const block of note.blocks)
        if (block.vector !== null && block.vector.length !== expected)
          throw new MixedVectorsError(expected as number, block.vector.length);
      notes.get(note.path)?.blocks.forEach(release);
      note.blocks.forEach(hold);
      notes.set(note.path, note);
      rankable = null;
    },
    remove(path) {
      const note = notes.get(path);
      if (note === undefined) return;
      note.blocks.forEach(release);
      notes.delete(path);
      rankable = null;
    },
    rankable() {
      rankable ??= rankableOf(notes, dimension);
      return rankable;
    },
  };
}

function rankableOf(
  notes: ReadonlyMap<string, HeldNote>,
  dimension: number | null,
): RankableBlocks {
  const blocks: CachedBlock[] = [];
  const vectors: Float32Array[] = [];
  const archived: boolean[] = [];
  for (const path of [...notes.keys()].sort(byCodeUnit)) {
    const inArchive = isArchivedPath(path);
    for (const block of (notes.get(path) as HeldNote).blocks) {
      if (block.vector === null) continue;
      blocks.push(block);
      vectors.push(block.vector);
      archived.push(inArchive);
    }
  }
  return { blocks, vectors, archived, dimension };
}
