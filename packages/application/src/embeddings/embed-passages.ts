import { halvedChunk, passageOf, type BlockChunk } from '@dfai/domain';
import { EmbeddingError, type EmbeddingPort, type RefusedText } from './ports.ts';

/**
 * The most passages sent to the model at once: about 70 ms of its work on
 * this Mac (ADR-0031), so a search typed while the cache builds waits behind
 * at most that.
 */
export const PASSAGES_PER_CALL = 32;

/**
 * The vectors known by passage digest: a vector, or null when the model will
 * not read the passage. A `Map` is one; the build layers its own over the
 * window's copy of the cache (`SemanticBlocks.vectorOf`), so none is copied.
 */
export interface KnownVectors {
  has(digest: string): boolean;
  get(digest: string): Float32Array | null | undefined;
  set(digest: string, vector: Float32Array | null): void;
}

/** The two halves a chunk the model found too long was cut into, by the digest of the whole. */
export type HalvedChunks = Map<string, readonly [BlockChunk, BlockChunk]>;

/** A note's chunks while its vectors are found; a chunk the model finds too long is halved in place. */
export interface ChunkedNote {
  chunks: BlockChunk[];
}

/**
 * Finds a vector for every chunk of these notes whose digest `known` lacks,
 * a call of at most `PASSAGES_PER_CALL` at a time, and adds each to `known`.
 * The same passage in two places is sent once.
 *
 * A text the model refuses (ADR-0031) is settled and the call sent again
 * without it: one too long is halved where it stands, and its halves sent in
 * its place; one it cannot read is known as null, so it is not sent again.
 * Every refusal makes a text shorter or takes it out, so this ends. Any other
 * failure — no model, no network — is thrown, and nothing is half done.
 */
export async function embedPassages({
  notes,
  known,
  embedder,
  halved = new Map(),
}: {
  notes: readonly ChunkedNote[];
  known: KnownVectors;
  embedder: EmbeddingPort;
  /**
   * Chunks already found too long: cut in halves before anything is sent, so a
   * note that is cut again does not send the whole to be refused again.
   */
  halved?: HalvedChunks;
}): Promise<void> {
  for (const note of notes) note.chunks = note.chunks.flatMap((chunk) => halvesOf(chunk, halved));
  for (;;) {
    const wanted = unknownPassages(notes, known).slice(0, PASSAGES_PER_CALL);
    if (wanted.length === 0) return;
    let vectors: readonly Float32Array[];
    try {
      vectors = await embedder.embed({ texts: wanted.map(passageOf), purpose: 'passage' });
    } catch (cause) {
      if (!(cause instanceof EmbeddingError) || cause.refused === undefined) throw cause;
      settleRefusal({
        notes,
        known,
        halved,
        chunk: refusedChunk(wanted, cause.refused),
        cause,
      });
      continue;
    }
    if (vectors.length !== wanted.length)
      throw new EmbeddingError(
        `${wanted.length} passages were sent and ${vectors.length} vectors came back`,
      );
    wanted.forEach((chunk, at) => known.set(chunk.digest, vectors[at] as Float32Array));
  }
}

/** The first chunk of each passage no vector is known for, in the notes' order. */
function unknownPassages(notes: readonly ChunkedNote[], known: KnownVectors): BlockChunk[] {
  const seen = new Set<string>();
  const wanted: BlockChunk[] = [];
  for (const note of notes) {
    for (const chunk of note.chunks) {
      if (known.has(chunk.digest) || seen.has(chunk.digest)) continue;
      seen.add(chunk.digest);
      wanted.push(chunk);
    }
  }
  return wanted;
}

function refusedChunk(sent: readonly BlockChunk[], refused: RefusedText): BlockChunk {
  const chunk = sent[refused.textIndex];
  if (chunk === undefined)
    throw new EmbeddingError(`the model refused text ${refused.textIndex} of ${sent.length}`);
  return chunk;
}

/** A chunk as the halves it was cut into before, however deep, else as it is. */
function halvesOf(chunk: BlockChunk, halved: HalvedChunks): BlockChunk[] {
  const halves = halved.get(chunk.digest);
  return halves === undefined ? [chunk] : halves.flatMap((half) => halvesOf(half, halved));
}

function settleRefusal({
  notes,
  known,
  halved,
  chunk,
  cause,
}: {
  notes: readonly ChunkedNote[];
  known: KnownVectors;
  halved: HalvedChunks;
  chunk: BlockChunk;
  cause: EmbeddingError;
}): void {
  const halves = cause.refused?.reason === 'too-long' ? halvedChunk(chunk) : null;
  if (halves === null) {
    known.set(chunk.digest, null);
    return;
  }
  halved.set(chunk.digest, halves);
  for (const note of notes)
    note.chunks = note.chunks.flatMap((each) => (each.digest === chunk.digest ? halves : [each]));
}
