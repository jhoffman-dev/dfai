import { useEffect, useMemo, useRef } from 'react';
import {
  createSemanticEngine,
  type EmbeddingCachePort,
  type EmbeddingPort,
  type IdlePort,
  type IndexPort,
  type NoteChunker,
  type MarkdownPort,
  type NoteChanges,
  type SemanticEngine,
  type SemanticOptIn,
  type VaultFsPort,
} from '@dfai/application';

/** What semantic search runs on: the model and the cache in the host, and the window's idle moments. */
export interface SemanticPorts {
  readonly embedder: EmbeddingPort;
  readonly cache: EmbeddingCachePort;
  readonly idle: IdlePort;
  readonly optIn: SemanticOptIn;
  /** Cuts a note into its chunks off the window's thread; left out, they are cut in the window. */
  readonly chunker?: NoteChunker;
}

/**
 * Semantic search in the open vault (P32-02): one engine per vault, made
 * without any work — nothing is opened, read or embedded until the first
 * search, or until the index is ready in a vault where it was used before.
 * It hears every sync of the index, so the cache follows the notes.
 */
export function useSemanticSearch({
  ports,
  vault,
  fs,
  markdown,
  index,
  changes,
  indexReady,
}: {
  ports: SemanticPorts | undefined;
  vault: string | null;
  fs: Pick<VaultFsPort, 'readNotes'>;
  markdown: MarkdownPort;
  index: Pick<IndexPort, 'manifest'>;
  changes: NoteChanges;
  indexReady: boolean;
}): SemanticEngine | null {
  // Made while drawing, not in an effect: an engine does nothing until asked,
  // and a state change for it would draw the whole window again.
  const engine = useMemo(
    () =>
      ports === undefined || vault === null
        ? null
        : createSemanticEngine({ vault, fs, markdown, index, ...ports }),
    [ports, vault, fs, markdown, index],
  );
  const current = useRef(engine);
  current.current = engine;

  useEffect(() => {
    if (engine === null) return undefined;
    const stopHearing = changes.subscribe((news) => engine.hear(news));
    return () => {
      stopHearing();
      // Stopped only once another engine has taken its place: a remount of the
      // same window keeps the same engine, and its build, going.
      queueMicrotask(() => {
        if (current.current !== engine) engine.stop();
      });
    };
  }, [engine, changes]);

  useEffect(() => {
    if (engine === null || vault === null || !indexReady) return;
    if (!ports?.optIn.isOn(vault)) return;
    // Each time the index is ready again — after a rebuild too, whose first sync is not news.
    engine.start().catch((cause: unknown) => {
      console.error('Semantic search could not start:', cause);
    });
  }, [engine, vault, indexReady, ports]);

  return engine;
}
