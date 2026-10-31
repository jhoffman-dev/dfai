import {
  createVaultPath,
  rankRelatedNotes,
  wikiLinkTargetWith,
  type RelatedExclusions,
  type VaultPath,
} from '@dfai/domain';
import type { BuildProgress } from './embedding-build.ts';
import type { SemanticBlocks } from './semantic-blocks.ts';

/** Which note to find related notes for, and what is never offered. */
export interface RelatedQuery {
  readonly path: string;
  /** Notes joined to it either way already, and those dismissed for it. */
  readonly exclude: Omit<RelatedExclusions, 'note'>;
  /** At most this many; `RELATED_NOTES.fallback` when not said. */
  readonly limit?: number;
}

/** A note close in meaning to the one asked about, and the link that would join them. */
export interface RelatedSuggestion {
  readonly path: string;
  readonly title: string;
  /** What goes inside `[[…]]` to link it: its bare name, or its path where the name is shared. */
  readonly target: string;
  /** Cosine similarity of its closest block, from -1 to 1: higher is closer. */
  readonly score: number;
}

/** The notes related to one, best first, and whether it could be asked at all. */
export interface RelatedAnswer {
  readonly notes: readonly RelatedSuggestion[];
  /**
   * Whether the note asked about is in the cache with a vector: until it is
   * — the cache still being built, or the note too new — nothing can be
   * related to it, and `notes` is empty.
   */
  readonly embedded: boolean;
  readonly progress: BuildProgress;
}

export interface RelatedByMeaningDeps {
  readonly blocks: SemanticBlocks;
  readonly progress: () => BuildProgress;
  readonly resolve: () => (target: string) => VaultPath | null;
  /**
   * Whether a note is in the vault, as the index says now. The cache can
   * still hold a note deleted or renamed while its forget waits behind a long
   * build: it is never offered, or Accept would write a link to nothing.
   */
  readonly inVault: (path: string) => boolean;
}

/**
 * The notes closest in meaning to a note, from the vectors its blocks
 * already have in the cache (ADR-0031): the model is never asked anything,
 * so this costs no fetch and no embedding, only a pass over the cache.
 * Which notes may be offered is the domain's rule (`rankRelatedNotes`).
 */
export function relatedByMeaning(deps: RelatedByMeaningDeps, asked: RelatedQuery): RelatedAnswer {
  const held = deps.blocks.note(asked.path);
  const embedded = held?.blocks.some((block) => block.vector !== null) ?? false;
  if (!embedded) return { notes: [], embedded, progress: deps.progress() };

  const ranked = deps.blocks.rankable();
  const blocks = ranked.blocks.flatMap((block, at) =>
    deps.inVault(block.path)
      ? [{ path: block.path, vector: ranked.vectors[at] as Float32Array }]
      : [],
  );
  const scores = rankRelatedNotes({
    blocks,
    excluded: { note: asked.path, ...asked.exclude },
    ...(asked.limit !== undefined && { limit: asked.limit }),
  });
  const resolve = deps.resolve();
  const notes = scores.map(({ path, score }) => ({
    path,
    title: deps.blocks.note(path)?.title ?? path,
    target: wikiLinkTargetWith(createVaultPath(path), resolve),
    score,
  }));
  return { notes, embedded, progress: deps.progress() };
}
