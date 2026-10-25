/**
 * A stand-in for the host's model and embeddings cache (`embeddings.rs`,
 * `embedding_cache.rs`), enough to drive semantic search end to end. The real
 * model's vectors, its refusals and the cache's SQL are tested in Rust; here
 * a text's vector is the meanings of its words, so a paraphrase points the
 * same way as what it paraphrases, and the same text always gets the same
 * vector.
 */

/** As many numbers as the real model's vectors have (Arctic Embed XS, ADR-0031). */
export const DIMENSIONS = 384;

/** Words of one meaning: a question in one finds a passage in another. */
const SAME_MEANING: readonly (readonly string[])[] = [
  ['pay', 'paid', 'payday', 'salary', 'wages', 'payroll'],
  ['vacation', 'holiday', 'leave', 'pto'],
  ['bees', 'hive', 'honey', 'beekeeping'],
];

/** Words that carry no meaning of their own. */
const SKIPPED = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'to',
  'of',
  'when',
  'what',
  'do',
  'we',
  'on',
]);

/** The fake model's vector for a text: unit length, or all zeros for a text of no words. */
export function meaningVector(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (SKIPPED.has(word)) continue;
    const meaning = SAME_MEANING.find((group) => group.includes(word))?.[0] ?? word;
    let hash = 0x811c9dc5;
    for (let at = 0; at < meaning.length; at += 1)
      hash = Math.imul(hash ^ meaning.charCodeAt(at), 0x01000193);
    const place = (hash >>> 0) % DIMENSIONS;
    vector[place] = (vector[place] ?? 0) + 1;
  }
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((value) => value / length);
}

interface CachedBlockRow {
  ordinal: number;
  digest: string;
  anchor: string | null;
  heading: string | null;
  excerpt: string;
  vector: number[] | null;
}

interface CachedNoteRow {
  path: string;
  digest: string;
  title: string;
  blocks: CachedBlockRow[];
}

/** The commands this stands in for. */
const COMMANDS = new Set([
  'embed',
  'embedding_cache_open',
  'embedding_cache_clear',
  'embedding_cache_load',
  'embedding_cache_excerpts',
  'embedding_cache_put',
  'embedding_cache_remove',
]);

export interface EmbeddingHost {
  handles(command: string): boolean;
  /** Answers one command for the vault open now. */
  answer(command: string, args: unknown, root: string): unknown;
  /** Every passage the app sent to be embedded, in order. */
  passages(): readonly string[];
  /**
   * The bytes of `embedding_cache_load` for the vault open now. They are served
   * to the page over HTTP (`host.ts`), not as numbers through `exposeFunction`:
   * 77 MB of vectors as numbers would be a stand-in's long task in the page,
   * not the app's.
   */
  loadBytes(root: string): Uint8Array;
  /** A slice of the bytes the last `embedding_cache_load` made, for the page to fetch a piece at a time. */
  loadSlice(from: number, to: number): Uint8Array;
}

/**
 * Each vault's cache, by root, kept for the window's life as the file on disk
 * outlives a launch. `msPerText` holds each call to embed as long as the real
 * model takes for that many passages — about 2.2 ms each on a Mac (ADR-0031)
 * — off the page's thread, as the host runs it; none unless asked.
 */
export function createEmbeddingHost({ msPerText = 0 }: { msPerText?: number } = {}): EmbeddingHost {
  const caches = new Map<string, Map<string, CachedNoteRow>>();
  const generations = new Map<string, string>();
  let open: string | null = null;
  const passages: string[] = [];
  let lastLoad: Uint8Array = new Uint8Array(0);
  const cache = () => {
    if (open === null) throw new Error('the embeddings cache is not open');
    return caches.get(open) as Map<string, CachedNoteRow>;
  };

  const answers: Record<string, (args: Record<string, unknown>, root: string) => unknown> = {
    embed: async ({ texts, purpose }) => {
      const sent = texts as string[];
      if (msPerText > 0) await new Promise((done) => setTimeout(done, msPerText * sent.length));
      if (purpose === 'passage') passages.push(...sent);
      return sent.map(meaningVector);
    },
    embedding_cache_open: ({ generation }, root) => {
      const fresh = generations.get(root) !== generation;
      if (fresh) caches.set(root, new Map());
      generations.set(root, String(generation));
      open = root;
      return { fresh };
    },
    embedding_cache_clear: () => {
      cache().clear();
      return null;
    },
    // Counted here; the page fetches the bytes in pieces (`loadSlice`), as many as its length says.
    embedding_cache_load: (_args, root) => {
      lastLoad = loadBytes(caches.get(root) ?? new Map());
      return lastLoad.length;
    },
    embedding_cache_excerpts: ({ keys }) =>
      (keys as { path: string; ordinal: number; digest: string }[]).map(
        ({ path, ordinal, digest }) =>
          cache()
            .get(path)
            ?.blocks.find((block) => block.ordinal === ordinal && block.digest === digest)
            ?.excerpt ?? '',
      ),
    embedding_cache_put: ({ vault, notes }) => {
      if (vault !== open) throw new Error('another vault was opened before this could be cached');
      for (const note of notes as CachedNoteRow[]) cache().set(note.path, note);
      return null;
    },
    embedding_cache_remove: ({ vault, paths }) => {
      if (vault !== open) throw new Error('another vault was opened before this could be cached');
      for (const path of paths as string[]) cache().delete(path);
      return null;
    },
  };

  return {
    handles: (command) => COMMANDS.has(command),
    answer: (command, args, root) =>
      (answers[command] as (args: Record<string, unknown>, root: string) => unknown)(
        (args ?? {}) as Record<string, unknown>,
        root,
      ),
    passages: () => passages,
    loadBytes: (root) => loadBytes(caches.get(root) ?? new Map()),
    loadSlice: (from, to) => lastLoad.subarray(from, to),
  };
}

/**
 * The load as `embedding_cache.rs` writes it: header length, the header as
 * lines (notes and vector length, then blocks a thousand to a line), spaces to
 * a multiple of 4, then little-endian f32s.
 */
function loadBytes(notes: ReadonlyMap<string, CachedNoteRow>): Uint8Array {
  const sorted = [...notes.values()].sort((left, right) => (left.path < right.path ? -1 : 1));
  const blocks = sorted.flatMap((note) =>
    [...note.blocks]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((block) => ({ path: note.path, ...block })),
  );
  const listed = blocks.map(({ path, ordinal, digest, anchor, heading, vector }) => ({
    path,
    ordinal,
    digest,
    anchor,
    heading,
    embedded: vector !== null,
  }));
  const dimensions = blocks.find((block) => block.vector !== null)?.vector?.length ?? 0;
  const lines = [
    JSON.stringify({
      dimensions,
      notes: sorted.map(({ path, digest, title }) => ({ path, digest, title })),
    }),
  ];
  for (let at = 0; at < listed.length; at += 1_000)
    lines.push(JSON.stringify(listed.slice(at, at + 1_000)));
  let text = lines.join('\n');
  let header = new TextEncoder().encode(text);
  while (header.length % 4 !== 0) {
    text += ' ';
    header = new TextEncoder().encode(text);
  }
  const vectors = blocks.flatMap((block) => block.vector ?? []);
  const bytes = new Uint8Array(4 + header.length + vectors.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, header.length, true);
  bytes.set(header, 4);
  vectors.forEach((value, at) => view.setFloat32(4 + header.length + at * 4, value, true));
  return bytes;
}
