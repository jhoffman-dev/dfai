/**
 * What a text is for. The model reads a question with a prefix it was trained
 * on and a passage without one, so the two must be asked for differently.
 */
export type EmbeddingPurpose = 'query' | 'passage';

/**
 * Turning text into vectors, with the small model the host runs on this Mac
 * (ADR-0031). The host only runs the model: which blocks are embedded, how a
 * note is cut into them and what counts as related are decided on this side.
 */
export interface EmbeddingPort {
  /**
   * One vector per text, in the order sent, each of unit length — so how alike
   * two texts are is the dot product of their vectors. The first call on a Mac
   * waits for the model to be fetched (91 MB); the first call after each
   * launch waits for it to be checked and loaded.
   *
   * Rejects with `EmbeddingError` when the host will not take the call: more
   * texts or bytes than it takes at once, a model it cannot fetch or load, or
   * one text it cannot read whole — which the error names (ADR-0031).
   */
  embed(args: {
    texts: readonly string[];
    purpose: EmbeddingPurpose;
  }): Promise<readonly Float32Array[]>;
}

/**
 * Why the host refused one text. `too-long`: more tokens than the model reads,
 * so split it. `nothing-readable`: nothing but whitespace, control or
 * zero-width characters, emoji, or a script the model lacks. `unreadable-run`:
 * a long stretch the model would read as one unknown word, such as an unspaced
 * script or a pasted blob of data.
 */
export type EmbeddingRefusalReason = 'too-long' | 'nothing-readable' | 'unreadable-run';

/** The text a refusal is about: its position in the call, from 0, and why. */
export interface RefusedText {
  readonly textIndex: number;
  readonly reason: EmbeddingRefusalReason;
}

/**
 * A refusal from the host while embedding. `refused` is set when one text
 * was the cause, and absent when the call as a whole was refused or failed.
 */
export class EmbeddingError extends Error {
  readonly refused: RefusedText | undefined;

  constructor(message: string, refused?: RefusedText) {
    super(message);
    this.name = 'EmbeddingError';
    this.refused = refused;
  }
}

/**
 * Thrown by the cache when it found its file damaged and made it again, empty:
 * whatever the window believes is cached is not, and it starts over from the notes.
 */
export class CacheDamagedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheDamagedError';
  }
}

/** A note as the embeddings cache holds it: the digest of the text it was cut from, and its title. */
export interface CachedNote {
  readonly path: string;
  readonly digest: string;
  readonly title: string;
}

/** One block of a note as the cache holds it, but its words, which are read only for a hit. */
export interface CachedBlock {
  readonly path: string;
  readonly ordinal: number;
  /** Of the passage embedded: the same digest, and the vector is reused. */
  readonly digest: string;
  readonly anchor: string | null;
  readonly heading: string | null;
  /** Null when the model would not read the block: it is known, and not sent again. */
  readonly vector: Float32Array | null;
}

/** A note's blocks, with what a hit shows of each, in place of whatever the cache held of it. */
export interface NoteToCache extends CachedNote {
  readonly blocks: readonly (Omit<CachedBlock, 'path'> & { readonly excerpt: string })[];
}

/** Everything the cache holds of a vault, but the blocks' words. */
export interface CachedEmbeddings {
  readonly notes: readonly CachedNote[];
  /** In path order, then each note's order. */
  readonly blocks: readonly CachedBlock[];
}

/**
 * Which block of which note, for reading its words back. The digest says which
 * block it was when it was ranked: a block that has since changed has other
 * words under its place, and a read of it finds nothing rather than those.
 */
export interface BlockKey {
  readonly path: string;
  readonly ordinal: number;
  readonly digest: string;
}

/**
 * The embeddings cache of the open vault (ADR-0031): derived, disposable, and
 * a file of its own beside the index in `.atlas-cache/`. It stores and reads
 * back; which notes to embed, how they are cut and how blocks are compared
 * are decided on this side.
 */
export interface EmbeddingCachePort {
  /**
   * Opens the open vault's cache for vectors of `generation` — the chunking
   * rules' version. One of another generation, or another model's, is thrown
   * away and made afresh, and says so.
   */
  open(args: { generation: string }): Promise<{ fresh: boolean }>;
  /** Throws the cache away and makes it again, empty. */
  clear(): Promise<void>;
  load(): Promise<CachedEmbeddings>;
  /** Each block's words, cut to what a hit shows, in the order asked; '' for a block the cache lacks or holds as another digest. */
  excerpts(keys: readonly BlockKey[]): Promise<readonly string[]>;
  /** Replaces each note's blocks, each note whole or not at all; refused once `vault` is not the one open. */
  put(notes: readonly NoteToCache[], scope: { vault: string }): Promise<void>;
  remove(paths: readonly string[], scope: { vault: string }): Promise<void>;
}

/**
 * When the window has time to spare. The cache is built a note at a time in
 * those moments, so a keystroke never waits behind it.
 */
export interface IdlePort {
  /** Resolves once the window is idle — or, if it never is, after a while anyway. */
  idle(): Promise<void>;
}
