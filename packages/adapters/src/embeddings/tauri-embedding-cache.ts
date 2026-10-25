import { invoke } from '@tauri-apps/api/core';
import {
  CacheDamagedError,
  type CachedBlock,
  type CachedEmbeddings,
  type CachedNote,
  type EmbeddingCachePort,
} from '@dfai/application';
import { throughHost } from '../vault/host-error.ts';

/** A block as `embedding_cache_load` lists it, before its vector is matched up. */
interface LoadedBlock extends Omit<CachedBlock, 'vector'> {
  readonly embedded: boolean;
}

/** The first line of the load's header: the rest is lines of blocks. */
interface LoadedHeader {
  /** How many numbers each vector has; 0 when none does. */
  readonly dimensions: number;
  readonly notes: readonly CachedNote[];
}

/** What the host says of a cache it found torn and made again (`DAMAGED` in `embedding_cache.rs`). */
const DAMAGED = 'the embeddings cache was damaged and was made again';

const asError = (message: string): Error =>
  message.includes(DAMAGED)
    ? new CacheDamagedError(`The embeddings cache: ${message}`)
    : new Error(`The embeddings cache: ${message}`);

/** How long the window may go on reading before it lets a frame go by. */
const SLICE_MILLISECONDS = 8;

const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const NEWLINE = 0x0a;

/**
 * Reads the load's bytes (`embedding_cache.rs`): a little-endian u32 giving
 * the length of the header, the header, then the vectors of the blocks it marks
 * embedded, in its order, as little-endian f32s. The header is lines of JSON —
 * the notes and the vector length, then the blocks a thousand to a line — read
 * a few milliseconds at a time with `pause` between, so a vault of 50,000
 * blocks is never one stretch of parsing that holds a frame back. Each vector
 * is a view over the one copy of the bytes, not a copy of its own.
 */
export async function readCacheLoad(
  bytes: ArrayBuffer,
  pause: () => Promise<void> = nextTurn,
): Promise<CachedEmbeddings> {
  const length = new DataView(bytes).getUint32(0, true);
  const lines = new Uint8Array(bytes, 4, length);
  const decoder = new TextDecoder();
  const nextLine = lineReader(lines);
  const first = nextLine();
  if (first === null) throw asError('the load has no header');
  const header = JSON.parse(decoder.decode(first)) as LoadedHeader;

  const listed: LoadedBlock[] = [];
  let sliceStart = performance.now();
  for (let line = nextLine(); line !== null; line = nextLine()) {
    for (const block of JSON.parse(decoder.decode(line)) as LoadedBlock[]) listed.push(block);
    if (performance.now() - sliceStart > SLICE_MILLISECONDS) {
      await pause();
      sliceStart = performance.now();
    }
  }
  return { notes: header.notes, blocks: withVectors({ listed, header, bytes, start: 4 + length }) };
}

/** The lines of `bytes`, one at a time, null at the end; trailing spaces are padding. */
function lineReader(bytes: Uint8Array): () => Uint8Array | null {
  let from = 0;
  return () => {
    if (from > bytes.length) return null;
    const found = bytes.indexOf(NEWLINE, from);
    const end = found < 0 ? bytes.length : found;
    const line = bytes.subarray(from, end);
    from = end + 1;
    return line;
  };
}

function withVectors({
  listed,
  header,
  bytes,
  start,
}: {
  listed: readonly LoadedBlock[];
  header: LoadedHeader;
  bytes: ArrayBuffer;
  start: number;
}): CachedBlock[] {
  const embedded = listed.reduce((count, block) => count + (block.embedded ? 1 : 0), 0);
  const floats = (bytes.byteLength - start) / 4;
  const { dimensions } = header;
  if (!Number.isInteger(floats) || floats !== embedded * dimensions) {
    throw asError(`${floats} numbers cannot be ${embedded} vectors of ${dimensions}`);
  }
  // A Float32Array must start on a multiple of 4, which the host's padding makes of it: copied once if not.
  const numbers =
    start % 4 === 0 ? new Float32Array(bytes, start) : new Float32Array(bytes.slice(start));
  let next = 0;
  return listed.map(({ embedded: has, ...block }): CachedBlock => {
    if (!has) return { ...block, vector: null };
    const vector = numbers.subarray(next * dimensions, (next + 1) * dimensions);
    next += 1;
    return { ...block, vector };
  });
}

/**
 * The embeddings cache through the host (`embedding_cache.rs`), which keeps
 * it in `.atlas-cache/embeddings.sqlite`. This end only translates: vectors
 * go as plain numbers and come back as bytes.
 */
export const tauriEmbeddingCache: EmbeddingCachePort = {
  async open({ generation }) {
    return throughHost(invoke<{ fresh: boolean }>('embedding_cache_open', { generation }), asError);
  },
  async clear() {
    await throughHost(invoke('embedding_cache_clear'), asError);
  },
  async load() {
    return readCacheLoad(await throughHost(invoke<ArrayBuffer>('embedding_cache_load'), asError));
  },
  async excerpts(keys) {
    return throughHost(invoke<string[]>('embedding_cache_excerpts', { keys }), asError);
  },
  async put(notes, { vault }) {
    const sent = notes.map((note) => ({
      ...note,
      blocks: note.blocks.map((block) => ({
        ...block,
        vector: block.vector === null ? null : Array.from(block.vector),
      })),
    }));
    await throughHost(invoke('embedding_cache_put', { vault, notes: sent }), asError);
  },
  async remove(paths, { vault }) {
    await throughHost(invoke('embedding_cache_remove', { vault, paths }), asError);
  },
};
