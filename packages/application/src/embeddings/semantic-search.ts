import {
  blockLink,
  createVaultPath,
  cutAtCharacter,
  MAX_CHUNK_CHARACTERS,
  topByCosine,
  type VaultPath,
} from '@dfai/domain';
import type { BuildProgress } from './embedding-build.ts';
import {
  EmbeddingError,
  type CachedBlock,
  type EmbeddingCachePort,
  type EmbeddingPort,
} from './ports.ts';
import type { SemanticBlocks } from './semantic-blocks.ts';

/** How many hits a search gives when it is not told, and the most it ever gives. */
export const SEMANTIC_HITS = { fallback: 20, max: 100 } as const;

/** A question asked of the vault by meaning. */
export interface SemanticQuery {
  /** Words, in any phrasing: "when does Mara get paid" finds "pay day moves to Friday". */
  readonly query: string;
  /**
   * At most this many hits: `SEMANTIC_HITS.fallback` when not said or not a
   * number, never fewer than 1 nor more than `.max`.
   */
  readonly limit?: number;
  /** The Archive's notes too; left out unless asked for, as the word search leaves them (U-22). */
  readonly includeArchived?: boolean;
}

/** One block that answers a question, with the link that cites it. */
export interface SemanticHit {
  readonly path: string;
  /** The note's title. */
  readonly title: string;
  /** What the block says, cut to an excerpt. */
  readonly text: string;
  /** The heading the block sits under, or null. */
  readonly heading: string | null;
  /** The block's `^id` when it has one; a hit opens there. */
  readonly block: string | null;
  /** `[[Note#^id]]`, else `[[Note#Heading]]`, else `[[Note]]` (ADR-0022): what an answer cites. */
  readonly link: string;
  /** Cosine similarity to the question, from -1 to 1: higher is closer. */
  readonly score: number;
}

/** The blocks closest to a question, best first, and how much of the vault they were found among. */
export interface SemanticAnswer {
  readonly hits: readonly SemanticHit[];
  /**
   * The build's progress as the search ran: while `done < total`, notes not
   * yet embedded could not be found, and an answer may be missing them.
   */
  readonly progress: BuildProgress;
}

/** Semantic search over one vault, as the palette, the API and the assistant ask it. */
export interface SemanticSearch {
  search(asked: SemanticQuery): Promise<SemanticAnswer>;
}

/** Semantic search that can be told apart from one that has not been asked for on this Mac. */
export interface SemanticAccess extends SemanticSearch {
  /** Whether search by meaning has been turned on here; the API and the assistant never turn it on. */
  isOn(): boolean;
}

/** The most of a question the model is given; a longer one is cut there, at a character. */
export const MAX_QUERY_CHARACTERS = MAX_CHUNK_CHARACTERS;

/**
 * Thrown when the cache holds vectors of another length than the model gives
 * the question: they are from another model, so the cache is not to be used.
 */
export class CacheMismatchError extends Error {
  constructor(cached: number, asked: number) {
    super(`the cache holds vectors of ${cached} numbers and the model gives ${asked}`);
    this.name = 'CacheMismatchError';
  }
}

export interface SemanticSearchDeps {
  readonly blocks: SemanticBlocks;
  readonly embedder: EmbeddingPort;
  readonly cache: Pick<EmbeddingCachePort, 'excerpts'>;
  readonly progress: () => BuildProgress;
  /**
   * How links find notes in the vault: of every note the index holds, not only
   * those embedded so far, so a link is never shorter than the vault allows.
   */
  readonly resolve: () => (target: string) => VaultPath | null;
  /** The last question's vector, so a search asked again because the cache moved does not ask the model again. */
  readonly questions?: QuestionVectors;
}

/** The vector of the last question asked; null when the model found nothing to read in it. */
export interface QuestionVectors {
  last: { readonly query: string; readonly vector: Float32Array | null } | null;
}

/** How many times a search ranks again because a block it found was changed under it. */
const ATTEMPTS = 3;

/**
 * The blocks most like the question, by cosine over every block in the cache
 * (ADR-0031): the question is embedded as a query, which the model reads
 * differently from a passage, and compared with each block's vector. A
 * question with nothing the model can read finds nothing; one too long for
 * it is cut to what it reads.
 */
export async function semanticSearch(
  deps: SemanticSearchDeps,
  asked: SemanticQuery,
): Promise<SemanticAnswer> {
  const query = asked.query.trim();
  const limit = hitLimit(asked.limit);
  if (query === '') return { hits: [], progress: deps.progress() };
  const vector = await questionVector(deps, query);
  if (vector === null) return { hits: [], progress: deps.progress() };

  let hits: SemanticHit[] = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const found = rank(deps.blocks, {
      vector,
      limit,
      includeArchived: asked.includeArchived === true,
    });
    // A block changed since it was ranked has another block's words under its place: ranked again.
    const keys = found.map(({ block: { path, ordinal, digest } }) => ({ path, ordinal, digest }));
    const excerpts = await deps.cache.excerpts(keys);
    hits = found.flatMap(({ block, score }, at) => {
      const text = excerpts[at] ?? '';
      return text === '' ? [] : [hitOf(deps, { block, score, text })];
    });
    if (hits.length === found.length) break;
  }
  return { hits, progress: deps.progress() };
}

function hitLimit(asked: number | undefined): number {
  if (asked === undefined || !Number.isFinite(asked)) return SEMANTIC_HITS.fallback;
  return Math.min(Math.max(1, Math.trunc(asked)), SEMANTIC_HITS.max);
}

function rank(
  blocks: SemanticBlocks,
  {
    vector,
    limit,
    includeArchived,
  }: { vector: Float32Array; limit: number; includeArchived: boolean },
) {
  const ranked = blocks.rankable();
  if (ranked.dimension !== null && ranked.dimension !== vector.length)
    throw new CacheMismatchError(ranked.dimension, vector.length);
  const include = includeArchived ? undefined : (at: number) => ranked.archived[at] !== true;
  return topByCosine({
    query: vector,
    vectors: ranked.vectors,
    limit,
    ...(include && { include }),
  }).map(({ at, score }) => ({ block: ranked.blocks[at] as CachedBlock, score }));
}

function hitOf(
  deps: SemanticSearchDeps,
  { block, score, text }: { block: CachedBlock; score: number; text: string },
): SemanticHit {
  return {
    path: block.path,
    title: deps.blocks.note(block.path)?.title ?? block.path,
    text,
    heading: block.heading,
    block: block.anchor,
    link: blockLink({
      path: createVaultPath(block.path),
      anchor: block.anchor,
      heading: block.heading,
      resolve: deps.resolve(),
    }),
    score,
  };
}

/** The question's vector, remembered for the next search of the same question. */
async function questionVector(
  deps: SemanticSearchDeps,
  query: string,
): Promise<Float32Array | null> {
  const remembered = deps.questions?.last;
  if (remembered?.query === query) return remembered.vector;
  const vector = await queryVector(deps.embedder, query);
  if (deps.questions !== undefined) deps.questions.last = { query, vector };
  return vector;
}

/**
 * The question's vector; null when the model finds nothing in it to read. A
 * question longer than the model reads is cut to `MAX_QUERY_CHARACTERS`, and
 * to half again each time the model still finds it too long: an answer to the
 * first part of it, not an error.
 */
async function queryVector(embedder: EmbeddingPort, query: string): Promise<Float32Array | null> {
  let text = cutAtCharacter(query, MAX_QUERY_CHARACTERS);
  while (text !== '') {
    try {
      const [vector] = await embedder.embed({ texts: [text], purpose: 'query' });
      return vector ?? null;
    } catch (cause) {
      const reason = cause instanceof EmbeddingError ? cause.refused?.reason : undefined;
      if (reason === 'too-long') text = cutAtCharacter(text, Math.floor(text.length / 2));
      else if (reason === 'nothing-readable' || reason === 'unreadable-run') return null;
      else throw cause;
    }
  }
  return null;
}
