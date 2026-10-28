import { isArchivedPath } from '../archive/archive.ts';
import { cosine } from '../embeddings/cosine-ranking.ts';
import { isEmbeddableNote } from '../embeddings/embedding-plan.ts';
import type { VaultGraph } from '../graph/vault-graph.ts';

/** How many related notes are offered when not said, and the most ever offered. */
export const RELATED_NOTES = { fallback: 8, max: 50 } as const;

/** One block of a note with its vector, as the related notes are ranked from. */
export interface RelatableBlock {
  readonly path: string;
  readonly vector: Float32Array;
}

/** A note offered as related, and how close its closest block is to the note asked about. */
export interface RelatedScore {
  readonly path: string;
  /** Cosine similarity, from -1 to 1: higher is closer. */
  readonly score: number;
}

/** What is never offered as related to `note`. */
export interface RelatedExclusions {
  /** The note asked about: never related to itself. */
  readonly note: string;
  /** Notes already joined to it either way, by a link or a relation: already connected. */
  readonly linked: ReadonlySet<string>;
  /** Notes the person dismissed for this note. */
  readonly dismissed: ReadonlySet<string>;
}

/** How many to offer: `RELATED_NOTES.fallback` when not said or not a number, never below 1 nor above `.max`. */
export function relatedLimit(asked: number | undefined): number {
  if (asked === undefined || !Number.isFinite(asked)) return RELATED_NOTES.fallback;
  return Math.min(Math.max(1, Math.trunc(asked)), RELATED_NOTES.max);
}

/**
 * Every note joined to `path` either way — a link in its body, a link to it
 * in another's, or a relation in either's properties — read from the graph
 * the foot of the note and the graph page draw, so "already linked" means
 * the same thing everywhere. Archived notes count too: a link is a link.
 */
export function linkedEitherWay(graph: VaultGraph, path: string): Set<string> {
  const linked = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.source === path) linked.add(edge.target);
    if (edge.target === path) linked.add(edge.source);
  }
  return linked;
}

/**
 * Whether `candidate` may be offered as related: not the note itself, not
 * already linked either way, not dismissed, not in the Archive (out of the
 * way, as search leaves it, U-22), and a note of the person's own space —
 * never a template or anything else DFAI keeps under `.atlas`.
 */
export function isOfferedAsRelated(candidate: string, excluded: RelatedExclusions): boolean {
  return (
    candidate !== excluded.note &&
    !excluded.linked.has(candidate) &&
    !excluded.dismissed.has(candidate) &&
    !isArchivedPath(candidate) &&
    isEmbeddableNote(candidate)
  );
}

/**
 * Where a note's meaning points: the mean of its blocks' unit vectors, scaled
 * back to unit length, so one long note is not drawn to whichever of its
 * blocks is longest. Null for a note with no vectors, or whose vectors
 * cancel out or are not numbers: it points nowhere, and nothing is related.
 */
export function noteCentroid(vectors: readonly Float32Array[]): Float32Array | null {
  const first = vectors[0];
  if (first === undefined) return null;
  const sum = new Float32Array(first.length);
  for (const vector of vectors) {
    if (vector.length !== sum.length) return null;
    for (let at = 0; at < sum.length; at += 1)
      sum[at] = (sum[at] as number) + (vector[at] as number);
  }
  let squares = 0;
  for (const value of sum) squares += value * value;
  const length = Math.sqrt(squares);
  if (!Number.isFinite(length) || length === 0) return null;
  return sum.map((value) => value / length);
}

/**
 * The notes closest in meaning to `note`, best first: each scored by its
 * block closest to where the note points ({@link noteCentroid}), and only
 * those {@link isOfferedAsRelated} lets through, and only those closer than
 * at right angles (a score above 0). Ties go by path, so the same
 * cache always offers the same notes in the same order. A block whose score
 * is not a finite number is skipped, never ranked.
 */
export function rankRelatedNotes({
  blocks,
  excluded,
  limit,
}: {
  blocks: readonly RelatableBlock[];
  excluded: RelatedExclusions;
  /** At most this many, as {@link relatedLimit} reads it. */
  limit?: number;
}): RelatedScore[] {
  const centroid = noteCentroid(
    blocks.filter((block) => block.path === excluded.note).map((block) => block.vector),
  );
  if (centroid === null) return [];
  const best = new Map<string, number>();
  for (const block of blocks) {
    if (block.vector.length !== centroid.length) continue;
    if (!isOfferedAsRelated(block.path, excluded)) continue;
    const score = cosine(centroid, block.vector);
    // At right angles or pointing away, a block has nothing in common with the note.
    if (!Number.isFinite(score) || score <= 0) continue;
    const held = best.get(block.path);
    if (held === undefined || score > held) best.set(block.path, score);
  }
  return [...best]
    .map(([path, score]) => ({ path, score }))
    .sort((left, right) => right.score - left.score || byCodeUnit(left.path, right.path))
    .slice(0, relatedLimit(limit));
}

const byCodeUnit = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
