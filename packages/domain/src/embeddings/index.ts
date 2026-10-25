/*
 * Semantic search's rules (P32-02, ADR-0031): how a note is cut into the
 * passages that are embedded, what says one is unchanged, which notes the
 * cache must embed or forget, how vectors are ranked, and the link a hit
 * cites. All pure; the cache, the model and the build are the application's.
 */
export {
  blockChunks,
  CHUNK_EXCERPT_LENGTH,
  CHUNKER_VERSION,
  chunkExcerpt,
  cutAtCharacter,
  halvedChunk,
  MAX_CHUNK_CHARACTERS,
  numbered,
  passageOf,
} from './block-chunks.ts';
export type { BlockChunk } from './block-chunks.ts';
export { blockLink } from './block-link.ts';
export { cosine, topByCosine, VectorLengthError } from './cosine-ranking.ts';
export type { Ranked } from './cosine-ranking.ts';
export { embeddingWork, isEmbeddableNote } from './embedding-plan.ts';
export type { EmbeddingWork } from './embedding-plan.ts';
export { passageDigest } from './passage-digest.ts';
