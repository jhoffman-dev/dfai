import {
  EmbeddingError,
  type BlockKey,
  type CachedBlock,
  type CachedEmbeddings,
  type CachedNote,
  type EmbeddingCachePort,
  type EmbeddingPort,
  type EmbeddingPurpose,
  type EmbeddingRefusalReason,
  type NoteToCache,
} from '../embeddings/ports.ts';

const DIMENSIONS = 1024;

/**
 * Words that mean the same to the fake model: a question in one of them finds
 * a passage in another, as the real model finds a paraphrase.
 */
const SAME_MEANING: readonly (readonly string[])[] = [
  ['pay', 'paid', 'salary', 'wages', 'payroll', 'payday'],
  ['vacation', 'holiday', 'leave', 'off', 'pto'],
  ['bees', 'hive', 'honey', 'apiary'],
  ['car', 'vehicle', 'automobile'],
];

export interface FakeEmbedder extends EmbeddingPort {
  /** Every call, in order: its texts and what they were for. */
  readonly calls: { texts: readonly string[]; purpose: EmbeddingPurpose }[];
  /** Every text sent as a passage, across all calls. */
  passages(): string[];
}

/**
 * A deterministic stand-in for the model: a text is the words it holds, each
 * folded to a meaning (`SAME_MEANING`) and counted in one of 1,024 places, then
 * scaled to unit length. Texts sharing words, or words of one meaning, point
 * the same way. `refuse` names a text the host would refuse; `failWith`
 * makes every call fail as a missing model does.
 */
export function fakeEmbedder({
  refuse = () => null,
  failWith,
}: {
  refuse?: (text: string) => EmbeddingRefusalReason | null;
  failWith?: () => string | null;
} = {}): FakeEmbedder {
  const calls: { texts: readonly string[]; purpose: EmbeddingPurpose }[] = [];
  return {
    calls,
    passages: () =>
      calls.filter((call) => call.purpose === 'passage').flatMap((call) => [...call.texts]),
    async embed({ texts, purpose }) {
      const failure = failWith?.() ?? null;
      if (failure !== null) throw new EmbeddingError(failure);
      const refused = texts.findIndex((text) => refuse(text) !== null);
      if (refused >= 0) {
        const reason = refuse(texts[refused] as string) as EmbeddingRefusalReason;
        throw new EmbeddingError(`text ${refused} refused`, { textIndex: refused, reason });
      }
      calls.push({ texts: [...texts], purpose });
      return texts.map(meaningVector);
    },
  };
}

/** The fake model's vector for a text. */
export function meaningVector(text: string): Float32Array {
  const vector = new Float32Array(DIMENSIONS);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const meaning = SAME_MEANING.find((group) => group.includes(word))?.[0] ?? word;
    vector[bucketOf(meaning)] = (vector[bucketOf(meaning)] as number) + 1;
  }
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((value) => value / length);
}

function bucketOf(word: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < word.length; at += 1)
    hash = Math.imul(hash ^ word.charCodeAt(at), 0x01000193);
  return (hash >>> 0) % DIMENSIONS;
}

export interface MemoryEmbeddingCache extends EmbeddingCachePort {
  /** The vault the cache is of: a write naming another is refused, as the host refuses it. */
  vault: string;
  /** Every note written, in order, across every put. */
  readonly written: NoteToCache[];
  /** Fails the next put, as a write cut short by a quit does: nothing of it lands. */
  failNextPut(): void;
  /** The generation the cache was last opened for. */
  generation(): string | null;
}

/**
 * The embeddings cache in memory, kept between opens as the file on disk is
 * kept between launches. Opening it for another generation throws its
 * contents away, as `embedding_cache.rs` does.
 */
export function memoryEmbeddingCache({
  vault = '/vault',
}: { vault?: string } = {}): MemoryEmbeddingCache {
  const notes = new Map<string, CachedNote>();
  const blocks = new Map<string, NoteToCache['blocks']>();
  const written: NoteToCache[] = [];
  let generation: string | null = null;
  let failing = false;
  const assertVault = (meant: string, cache: MemoryEmbeddingCache) => {
    if (meant !== cache.vault)
      throw new Error('another vault was opened before this could be cached');
  };
  const cache: MemoryEmbeddingCache = {
    vault,
    written,
    failNextPut: () => {
      failing = true;
    },
    generation: () => generation,
    async open({ generation: wanted }) {
      const fresh = generation !== wanted;
      if (fresh) {
        notes.clear();
        blocks.clear();
      }
      generation = wanted;
      return { fresh };
    },
    async clear() {
      notes.clear();
      blocks.clear();
    },
    async load(): Promise<CachedEmbeddings> {
      const paths = [...notes.keys()].sort();
      return {
        notes: paths.map((path) => notes.get(path) as CachedNote),
        blocks: paths.flatMap((path) =>
          (blocks.get(path) ?? []).map((block): CachedBlock => ({
            path,
            ordinal: block.ordinal,
            digest: block.digest,
            anchor: block.anchor,
            heading: block.heading,
            vector: block.vector,
          })),
        ),
      };
    },
    async excerpts(keys: readonly BlockKey[]) {
      return keys.map(
        (key) =>
          blocks
            .get(key.path)
            ?.find((block) => block.ordinal === key.ordinal && block.digest === key.digest)
            ?.excerpt ?? '',
      );
    },
    async put(sent, scope) {
      assertVault(scope.vault, cache);
      if (failing) {
        failing = false;
        throw new Error('the write was cut short');
      }
      for (const note of sent) {
        notes.set(note.path, { path: note.path, digest: note.digest, title: note.title });
        blocks.set(note.path, note.blocks);
        written.push(note);
      }
    },
    async remove(paths, scope) {
      assertVault(scope.vault, cache);
      for (const path of paths) {
        notes.delete(path);
        blocks.delete(path);
      }
    },
  };
  return cache;
}
