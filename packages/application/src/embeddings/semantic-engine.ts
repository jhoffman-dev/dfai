import {
  CHUNKER_VERSION,
  createVaultPath,
  createWikiLinkResolver,
  type VaultPath,
} from '@dfai/domain';
import type { IndexPort } from '../index/ports.ts';
import type { NoteChangeNews } from '../index/note-changes.ts';
import type { MarkdownPort } from '../notes/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import {
  createEmbeddingBuild,
  type BuildProgress,
  type EmbeddingBuild,
  type NoteChunker,
} from './embedding-build.ts';
import { inlineChunker } from './note-passages.ts';
import {
  CacheDamagedError,
  type EmbeddingCachePort,
  type EmbeddingPort,
  type IdlePort,
} from './ports.ts';
import { createSemanticBlocks, type SemanticBlocks } from './semantic-blocks.ts';
import {
  CacheMismatchError,
  semanticSearch,
  type QuestionVectors,
  type SemanticAccess,
} from './semantic-search.ts';

/** What the cache's vectors were made by: the chunking rules; the host adds the model. */
export const EMBEDDING_GENERATION = `chunks-${CHUNKER_VERSION}`;

const NOT_STARTED: BuildProgress = { done: 0, total: 0, failure: null };

/**
 * How many times one session starts over a cache found damaged. A disk that
 * tears every write would otherwise clear it and send every note to the model
 * again without end; the next time, the build stops and says so. The count
 * lives in the engine, which is made again only when the app is (or another
 * vault is opened), so that is what the message tells.
 */
const MOST_STARTS_OVER = 2;
const GAVE_UP =
  'The embeddings cache kept being damaged, so semantic search stopped building it. Restart DFAI to try again.';

/**
 * Whether semantic search has been used in a vault on this Mac, so its cache
 * is kept up from the next launch on. Until it is first used nothing is
 * built: the first use fetches a 91 MB model (ADR-0031), which is the user's
 * to ask for.
 */
export interface SemanticOptIn {
  isOn(vault: string): boolean;
  turnOn(vault: string): void;
}

export interface SemanticEngineDeps {
  readonly vault: string;
  readonly fs: Pick<VaultFsPort, 'readNotes'>;
  readonly markdown: MarkdownPort;
  /**
   * Cuts a note into its chunks, where the window would rather not: a worker.
   * Left out, the notes are parsed on `markdown`, in the window.
   */
  readonly chunker?: NoteChunker;
  readonly index: Pick<IndexPort, 'manifest'>;
  readonly embedder: EmbeddingPort;
  readonly cache: EmbeddingCachePort;
  readonly idle: IdlePort;
  readonly optIn: SemanticOptIn;
  readonly onProgress?: (progress: BuildProgress) => void;
}

/**
 * Semantic search in one vault, with the build that keeps its cache up
 * (P32-02). Nothing is opened, read or embedded until `start` — called by
 * the first search, or at launch in a vault where it was used before.
 */
export interface SemanticEngine extends SemanticAccess {
  /**
   * Opens and loads the cache, if not yet, and queues the work between it
   * and the index's notes. Call again whenever the index has been rebuilt:
   * a rebuild's first sync is not news (`NoteChanges`).
   */
  start(): Promise<void>;
  /** Hands the build a sync's changes; ignored before `start` and for another vault. */
  hear(news: NoteChangeNews): void;
  progress(): BuildProgress;
  /** Told each time the build's progress moves — a write landed, it failed or it finished. */
  subscribe(listener: (progress: BuildProgress) => void): () => void;
  /** Resolves once the build has nothing queued, has failed, or was stopped. */
  settled(): Promise<void>;
  /** Stops the build for good: the vault is closing. */
  stop(): void;
}

export function createSemanticEngine(deps: SemanticEngineDeps): SemanticEngine {
  let opened: Promise<{ blocks: SemanticBlocks; build: EmbeddingBuild }> | null = null;
  let build: EmbeddingBuild | null = null;
  let stopped = false;
  let startsOver = 0;
  let gaveUp = false;
  let rebuilding: Promise<void> | null = null;
  const listeners = new Set<(progress: BuildProgress) => void>();
  const questions: QuestionVectors = { last: null };
  const chunker = deps.chunker ?? inlineChunker(deps.markdown);
  const onProgress = (progress: BuildProgress) => {
    deps.onProgress?.(progress);
    for (const listener of listeners) listener(progress);
  };

  // The notes the index holds, for the shortest link that still names a hit's note.
  // Worked out again only once the index has changed.
  let notePaths: Set<string> | null = null;
  let resolver: ((target: string) => VaultPath | null) | null = null;
  const resolve = () => {
    resolver ??= createWikiLinkResolver([...(notePaths ?? [])].map(createVaultPath));
    return resolver;
  };

  const open = async () => {
    const { fresh } = await deps.cache.open({ generation: EMBEDDING_GENERATION });
    const blocks = fresh ? createSemanticBlocks({ notes: [], blocks: [] }) : await loadedBlocks();
    build = createEmbeddingBuild({ ...deps, chunker, blocks, onProgress, onDamaged });
    if (stopped) build.stop();
    return { blocks, build };
  };
  /**
   * What the cache holds, or nothing: a cache that cannot be read back whole —
   * a torn file, vectors of different lengths — is thrown away and built
   * again, as it is derived and disposable (ADR-0031), never a dead end.
   */
  const loadedBlocks = async () => {
    try {
      return createSemanticBlocks(await deps.cache.load());
    } catch {
      // Why it is safe: the cache is cleared, and every note is embedded again from the vault.
      await deps.cache.clear();
      return createSemanticBlocks({ notes: [], blocks: [] });
    }
  };
  const opening = () => {
    opened ??= open().catch((cause: unknown) => {
      // The next start tries again: a cache that would not open now may later.
      opened = null;
      throw cause;
    });
    return opened;
  };
  /** The cache was torn and made again behind the build's back: what the window holds of it is gone. */
  const onDamaged = () => {
    queueMicrotask(() => {
      rebuild('damaged').catch((cause: unknown) => {
        console.error('Semantic search could not start over:', cause);
      });
    });
  };
  /**
   * Throws the cache away and starts over, one start-over at a time: a tear
   * heard twice — by the build and by a search — is started over once, by one
   * build. Only damage counts towards `MOST_STARTS_OVER`; a cache of another
   * model is started over once and then holds this one's vectors.
   */
  const rebuild = (why: 'damaged' | 'mismatch'): Promise<void> => {
    rebuilding ??= startOver(why).finally(() => {
      rebuilding = null;
    });
    return rebuilding;
  };
  const startOver = async (why: 'damaged' | 'mismatch') => {
    if (gaveUp) return;
    const outOfStarts = why === 'damaged' && startsOver >= MOST_STARTS_OVER;
    if (why === 'damaged' && !outOfStarts) startsOver += 1;
    const { build: stale } = await opening();
    stale.stop();
    await stale.settled();
    if (outOfStarts) {
      gaveUp = true;
      onProgress(progress());
      return;
    }
    await deps.cache.clear();
    opened = null;
    build = null;
    await start();
  };
  const progress = (): BuildProgress => {
    const now = build?.progress() ?? NOT_STARTED;
    return gaveUp ? { ...now, failure: GAVE_UP } : now;
  };
  const start = async () => {
    deps.optIn.turnOn(deps.vault);
    const { build: started } = await opening();
    const manifest = await deps.index.manifest();
    notePaths = new Set(manifest.map((entry) => entry.path));
    resolver = null;
    started.plan(new Map(manifest.map((entry) => [entry.path, entry.digest])));
  };

  return {
    start,
    isOn: () => deps.optIn.isOn(deps.vault),
    hear(news) {
      if (news.vault !== deps.vault) return;
      if (notePaths !== null) {
        for (const { kind, path } of news.changes) {
          if (kind === 'added') notePaths.add(path);
          else if (kind === 'removed') notePaths.delete(path);
        }
        resolver = null;
      }
      build?.hear(news.changes);
    },
    async search(asked) {
      if (opened === null) await start();
      const { blocks, build: started } = await opening();
      started.resume();
      try {
        return await semanticSearch(
          { blocks, embedder: deps.embedder, cache: deps.cache, progress, resolve, questions },
          asked,
        );
      } catch (cause) {
        if (!(cause instanceof CacheMismatchError || cause instanceof CacheDamagedError))
          throw cause;
        await rebuild(cause instanceof CacheDamagedError ? 'damaged' : 'mismatch');
        return { hits: [], progress: progress() };
      }
    },
    progress,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settled: async () => {
      await build?.settled();
    },
    stop() {
      stopped = true;
      build?.stop();
    },
  };
}
