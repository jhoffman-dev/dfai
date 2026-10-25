import {
  chunkExcerpt,
  createVaultPath,
  digestOf,
  embeddingWork,
  isEmbeddableNote,
  messageWithoutPaths,
  noteTitle,
  numbered,
  type NoteChange,
} from '@dfai/domain';
import type { NoteFile, VaultFsPort } from '../vault/ports.ts';
import {
  embedPassages,
  PASSAGES_PER_CALL,
  type HalvedChunks,
  type KnownVectors,
} from './embed-passages.ts';
import type { NotePassages } from './note-passages.ts';
import {
  CacheDamagedError,
  type EmbeddingCachePort,
  type EmbeddingPort,
  type IdlePort,
  type NoteToCache,
} from './ports.ts';
import type { HeldNote, SemanticBlocks } from './semantic-blocks.ts';

/** The most notes read before what they need is embedded and written. */
const NOTES_PER_WRITE = 16;

/** How far the build has got since it last had nothing to do. */
export interface BuildProgress {
  /** Notes embedded, or forgotten, since the build last had nothing to do. */
  readonly done: number;
  /** Those, and the notes still waiting. */
  readonly total: number;
  /** Why the build stopped, when it did; it starts again on the next `resume`. */
  readonly failure: string | null;
}

/**
 * Keeps the embeddings cache in step with a vault's notes, in the background
 * (P32-02). Notes are read and cut one per idle moment of the window, so
 * typing never waits behind the build; the model runs in the host, off the
 * window's thread. Each write holds whole notes, so a build stopped at any
 * point — a quit, a crash, a switch of vault — leaves only notes it had not
 * reached, and the next one starts from them (`embeddingWork`).
 */
export interface EmbeddingBuild {
  /** Queues the work between the cache and the vault's notes, named by path to digest. */
  plan(vault: ReadonlyMap<string, string>): void;
  /** Queues what one sync of the index found added, changed or removed. */
  hear(changes: readonly NoteChange[]): void;
  /** Starts again after a failure, with whatever is still queued. */
  resume(): void;
  /** Resolves once nothing is queued, the build has failed, or it was stopped. */
  settled(): Promise<void>;
  progress(): BuildProgress;
  /** Stops after the write under way, if any; nothing more is read, embedded or written. */
  stop(): void;
}

export interface EmbeddingBuildDeps {
  /** The vault the build is for: every write names it, and is refused once another is open. */
  readonly vault: string;
  readonly fs: Pick<VaultFsPort, 'readNotes'>;
  /**
   * Cuts a note's text into the chunks that are embedded. Parsing a long note
   * is work, so the window hands it to a worker (`NoteChunker`); it throws for
   * a note it cannot parse.
   */
  readonly chunker: NoteChunker;
  readonly embedder: EmbeddingPort;
  readonly cache: Pick<EmbeddingCachePort, 'put' | 'remove'>;
  readonly idle: IdlePort;
  readonly blocks: SemanticBlocks;
  /** Told each time the progress moves. */
  readonly onProgress?: (progress: BuildProgress) => void;
  /** Told once the build stopped because the cache was damaged and made again: nothing it holds is cached. */
  readonly onDamaged?: () => void;
}

/** A note file as its passages, wherever the parsing is done. */
export type NoteChunker = (files: readonly NoteFile[]) => Promise<readonly NotePassages[]>;

/** What to do with a note, and when it was asked: a note asked again while it is being read is read again. */
interface Work {
  readonly kind: 'embed' | 'forget';
  readonly asked: number;
}

export function createEmbeddingBuild(deps: EmbeddingBuildDeps): EmbeddingBuild {
  const queue = new Map<string, Work>();
  // What this build has learned about chunks the model found too long, for as long as it lives.
  const session: Session = { halved: new Map(), cautious: 0 };
  // Each note the write under way has read, by the digest it is embedded at (null: it is being forgotten).
  const reading = new Map<string, string | null>();
  let asked = 0;
  let done = 0;
  let failure: string | null = null;
  let stopped = false;
  let running: Promise<void> | null = null;
  // A resume asked for while a run is under way, which may yet fail: honoured once it ends.
  let resumeAsked = false;

  const progress = (): BuildProgress => ({ done, total: done + queue.size, failure });
  const tell = () => deps.onProgress?.(progress());

  const enqueue = (path: string, kind: Work['kind']) => {
    asked += 1;
    queue.delete(path);
    queue.set(path, { kind, asked });
  };

  const run = async () => {
    // Of this run alone: a run after it that ends well has not found the cache damaged.
    let damaged = false;
    try {
      while (!stopped && queue.size > 0)
        await oneWrite({ deps, queue, session, reading, isStopped: () => stopped, countDone });
    } catch (cause) {
      failure = messageWithoutPaths(cause);
      damaged = cause instanceof CacheDamagedError;
    } finally {
      reading.clear();
      running = null;
      if (queue.size === 0) done = 0;
      tell();
      if (damaged) {
        // The engine starts over with a new build: this one is not resumed, or it would tell twice.
        resumeAsked = false;
        deps.onDamaged?.();
      } else if (resumeAsked) {
        resumeAsked = false;
        failure = null;
        kick();
      }
    }
  };
  const countDone = (count: number) => {
    done += count;
    tell();
  };
  const kick = () => {
    if (stopped || failure !== null || running !== null || queue.size === 0) return;
    running = run();
  };

  /** One change of a sync, as work: what the cache holds and what is queued decide it. */
  const hearOne = (change: NoteChange) => {
    const queued = queue.get(change.path);
    if (change.kind === 'removed' || !isEmbeddableNote(change.path)) {
      // A note being embedded is not held yet: forgotten once it is, or it would be a ghost.
      if (deps.blocks.note(change.path) !== undefined || queued !== undefined)
        enqueue(change.path, 'forget');
    } else if (
      // A note being written is compared with what is being written, not with what is held.
      (reading.has(change.path)
        ? reading.get(change.path)
        : deps.blocks.note(change.path)?.digest) !== change.digest ||
      queued?.kind === 'forget'
    ) {
      // Back before its forget was written (or while it was): read again, whatever the cache holds.
      enqueue(change.path, 'embed');
    }
  };

  return {
    plan(vault) {
      const work = embeddingWork({ vault, cached: deps.blocks.digests() });
      for (const path of work.forget) enqueue(path, 'forget');
      for (const path of work.embed) enqueue(path, 'embed');
      tell();
      kick();
    },
    hear(changes) {
      changes.forEach(hearOne);
      tell();
      kick();
    },
    resume() {
      failure = null;
      if (running === null) kick();
      else resumeAsked = true;
    },
    settled: async () => {
      while (running !== null) await running;
    },
    progress,
    stop() {
      stopped = true;
    },
  };
}

/** What a build learns as it goes, and keeps for as long as it lives. */
interface Session {
  readonly halved: HalvedChunks;
  /**
   * A write of several notes failed: this many notes are written one at a
   * time, to find the one that cannot be, before notes are written together again.
   */
  cautious: number;
}

/**
 * Takes up to `NOTES_PER_WRITE` notes off the queue — fewer once they need
 * a call's worth of passages — and brings the cache and `blocks` up to them
 * in one write. A note is taken off only once written: stopped or failed
 * before, it is still queued for the next build.
 */
async function oneWrite({
  deps,
  queue,
  session,
  reading,
  isStopped,
  countDone,
}: {
  deps: EmbeddingBuildDeps;
  queue: Map<string, Work>;
  session: Session;
  reading: Map<string, string | null>;
  isStopped: () => boolean;
  countDone: (count: number) => void;
}): Promise<void> {
  reading.clear();
  const most = session.cautious > 0 ? 1 : NOTES_PER_WRITE;
  const taken: [string, Work][] = [];
  const forget: string[] = [];
  const read: NotePassages[] = [];
  let passages = 0;
  for (const [path, work] of [...queue]) {
    if (taken.length === most || passages >= PASSAGES_PER_CALL) break;
    taken.push([path, work]);
    if (work.kind === 'forget') {
      forget.push(path);
      reading.set(path, null);
      continue;
    }
    await deps.idle.idle();
    if (isStopped()) return;
    const note = await readNote(deps, path);
    reading.set(path, note?.digest ?? null);
    if (note === null) forget.push(path);
    else {
      read.push(note);
      passages += note.chunks.length;
    }
  }
  const notes = await embedded(deps, { read, halved: session.halved });
  if (isStopped()) return;
  await write(deps, { notes, forget, session });
  // A note asked for again while this write was made stays queued: it changed since it was read.
  for (const [path, work] of taken) if (queue.get(path) === work) queue.delete(path);
  session.cautious = Math.max(0, session.cautious - taken.length);
  countDone(taken.length);
}

/**
 * The note at `path` as passages; null when it is gone or is not one the
 * cache holds. One that cannot be parsed is held with no passages, so it is
 * not read again until it changes: one torn note must not stop the build.
 */
async function readNote(deps: EmbeddingBuildDeps, path: string): Promise<NotePassages | null> {
  if (!isEmbeddableNote(path)) return null;
  const [file] = await deps.fs.readNotes([path]);
  if (file === undefined) return null;
  try {
    const [passages] = await deps.chunker([file]);
    if (passages !== undefined) return passages;
  } catch {
    // Why it is safe: the note is written with no passages and its digest, and read again once it changes.
  }
  return {
    path,
    digest: digestOf(file.text),
    title: noteTitle(createVaultPath(path)),
    chunks: [],
  };
}

/** Each note with a vector for every chunk, reusing every one the cache already holds. */
async function embedded(
  deps: EmbeddingBuildDeps,
  { read, halved }: { read: readonly NotePassages[]; halved: HalvedChunks },
): Promise<NoteToCache[]> {
  const known = knownVectors(deps.blocks);
  const chunked = read.map((note) => ({ chunks: [...note.chunks] }));
  await embedPassages({ notes: chunked, known, embedder: deps.embedder, halved });
  return read.map((note, at) => ({
    path: note.path,
    digest: note.digest,
    title: wellFormed(note.title),
    blocks: numbered((chunked[at] as { chunks: typeof note.chunks }).chunks).map((chunk) => ({
      ordinal: chunk.ordinal,
      digest: chunk.digest,
      anchor: chunk.anchor === null ? null : wellFormed(chunk.anchor),
      heading: chunk.heading === null ? null : wellFormed(chunk.heading),
      excerpt: wellFormed(chunkExcerpt(chunk)),
      vector: known.get(chunk.digest) ?? null,
    })),
  }));
}

/**
 * The vectors the window holds (`SemanticBlocks.vectorOf`, a note moved
 * included) and those found by this write, without copying the first.
 */
function knownVectors(blocks: SemanticBlocks): KnownVectors {
  const found = new Map<string, Float32Array | null>();
  return {
    has: (digest) => found.has(digest) || blocks.vectorOf(digest) !== undefined,
    get: (digest) => (found.has(digest) ? found.get(digest) : blocks.vectorOf(digest)),
    set: (digest, vector) => void found.set(digest, vector),
  };
}

/** Text with no half of a surrogate pair, which the host's JSON reader would refuse. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const wellFormed = (text: string): string => text.replace(LONE_SURROGATE, '\uFFFD');

/**
 * Forgets and holds, each change in memory right after its own write to the
 * cache, so a write that fails part way leaves the window holding what the
 * cache holds.
 */
async function write(
  deps: EmbeddingBuildDeps,
  {
    notes,
    forget,
    session,
  }: { notes: readonly NoteToCache[]; forget: readonly string[]; session: Session },
): Promise<void> {
  const scope = { vault: deps.vault };
  if (forget.length > 0) {
    await deps.cache.remove(forget, scope);
    for (const path of forget) deps.blocks.remove(path);
  }
  if (notes.length === 0) return;
  let written = notes;
  try {
    await deps.cache.put(notes, scope);
  } catch (cause) {
    // A damaged cache was made again empty: no retry onto it; the build stops and starts over.
    if (cause instanceof CacheDamagedError) throw cause;
    if (notes.length > 1) {
      session.cautious = notes.length + forget.length;
      throw cause;
    }
    written = [await putAlone(deps, notes[0] as NoteToCache)];
  }
  for (const note of written) deps.blocks.put(heldNote(note));
}

/**
 * A note that cannot be written alone, twice, is the note and not the cache:
 * it is held with no blocks and its digest, as an unparseable one is, so it
 * is read again once it changes and the notes after it are still built. (A
 * write of several notes fails as it did, and its notes are then written one
 * at a time to find that one.) A cache that cannot even hold that throws.
 */
async function putAlone(deps: EmbeddingBuildDeps, note: NoteToCache): Promise<NoteToCache> {
  const scope = { vault: deps.vault };
  try {
    await deps.cache.put([note], scope);
    return note;
  } catch (cause) {
    if (cause instanceof CacheDamagedError) throw cause;
    // Why it is safe: the bare note below is written instead, and a cache that fails that throws.
    const bare = { ...note, blocks: [] };
    await deps.cache.put([bare], scope);
    return bare;
  }
}

function heldNote(note: NoteToCache): HeldNote {
  return {
    path: note.path,
    digest: note.digest,
    title: note.title,
    blocks: note.blocks.map((block) => ({
      path: note.path,
      ordinal: block.ordinal,
      digest: block.digest,
      anchor: block.anchor,
      heading: block.heading,
      vector: block.vector,
    })),
  };
}
