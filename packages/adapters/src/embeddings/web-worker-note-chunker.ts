import type { NoteChunker } from '@dfai/application';
import { remarkMarkdown } from '../markdown/markdown-port.ts';
import { windowNoteChunker, workerNoteChunker, type ChunkWorker } from './note-chunking.ts';

/**
 * Starts a worker from the index's script (`note-derivation.worker.ts`), which
 * also cuts notes into chunks: it already holds the markdown reader.
 */
function spawnChunkWorker(): ChunkWorker {
  const worker = new Worker(new URL('../index/note-derivation.worker.ts', import.meta.url), {
    type: 'module',
    name: 'atlas-embeddings',
  });
  return {
    post: (request) => worker.postMessage(request),
    stop: () => worker.terminate(),
    listen: ({ onAnswer, onCrash }) => {
      worker.onmessage = (event) => onAnswer(event.data);
      const crashed = (problem: string) => {
        worker.terminate();
        onCrash(problem);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        crashed(event.message || 'the chunking worker stopped');
      };
      worker.onmessageerror = () => crashed('a message from the chunking worker could not be read');
    },
  };
}

/** Cuts notes into chunks in a web worker, off the window's thread. */
export const webWorkerNoteChunker: NoteChunker = workerNoteChunker(spawnChunkWorker, {
  fallback: windowNoteChunker(remarkMarkdown),
});
