import { messageWithoutPaths } from '@dfai/domain';
import {
  inlineChunker,
  notePassages,
  type MarkdownPort,
  type NoteChunker,
  type NoteFile,
  type NotePassages,
} from '@dfai/application';

/** What the window asks of the worker: one note, to be cut into the chunks that are embedded. */
export interface ChunkRequest {
  readonly kind: 'chunk';
  readonly id: number;
  readonly file: NoteFile;
}

/** What the worker answers with: the note's plain passages, or why it could not be cut. */
export type ChunkAnswer =
  | { readonly kind: 'chunked'; readonly id: number; readonly passages: NotePassages }
  | { readonly kind: 'chunk-refused'; readonly id: number; readonly problem: string };

/** Whether a message is a chunking request, for a worker that also serves other work. */
export const isChunkRequest = (message: unknown): message is ChunkRequest =>
  typeof message === 'object' && message !== null && (message as ChunkRequest).kind === 'chunk';

/**
 * The worker's half: parses a note's markdown and cuts it into chunks, off the
 * window's thread, and answers with plain data. It touches no file and no host.
 */
export function serveNoteChunking({
  markdown,
  answer,
}: {
  markdown: MarkdownPort;
  answer: (answer: ChunkAnswer) => void;
}): (request: ChunkRequest) => void {
  return ({ id, file }) => {
    try {
      answer({ kind: 'chunked', id, passages: notePassages(file, markdown) });
    } catch (cause) {
      answer({ kind: 'chunk-refused', id, problem: messageWithoutPaths(cause) });
    }
  };
}

/** The little of a `Worker` this needs, so a test can stand one up in-process. */
export interface ChunkWorker {
  post(request: ChunkRequest): void;
  listen(heard: { onAnswer: (answer: unknown) => void; onCrash: (problem: string) => void }): void;
  stop?(): void;
}

/**
 * The window's half: reads no markdown itself. Each note is posted to a worker
 * and its passages come back, so the window's thread is held only to pass them
 * along (a 100 KB note parses in tens of milliseconds, which is a dropped frame).
 *
 * A worker that cannot be started or dies is given up on, and the notes are
 * parsed in the window from then on — a slower build, never none.
 */
export function workerNoteChunker(
  spawn: () => ChunkWorker,
  { fallback }: { fallback: NoteChunker },
): NoteChunker {
  interface Waiting {
    resolve(passages: NotePassages): void;
    reject(cause: Error): void;
  }
  const waiting = new Map<number, Waiting>();
  let worker: ChunkWorker | null = null;
  let gaveUp = false;
  let requests = 0;

  const giveUp = (problem: string) => {
    gaveUp = true;
    worker?.stop?.();
    worker = null;
    for (const asked of waiting.values()) asked.reject(new Error(problem));
    waiting.clear();
  };
  const heard = (answer: unknown) => {
    const { kind, id } = (answer ?? {}) as { kind?: unknown; id?: unknown };
    const asked = typeof id === 'number' ? waiting.get(id) : undefined;
    if (asked === undefined) return;
    waiting.delete(id as number);
    if (kind === 'chunked') asked.resolve((answer as { passages: NotePassages }).passages);
    else
      asked.reject(
        new Error((answer as { problem?: string }).problem ?? 'the note could not be cut'),
      );
  };
  const started = (): ChunkWorker | null => {
    if (gaveUp) return null;
    if (worker !== null) return worker;
    try {
      worker = spawn();
      worker.listen({ onAnswer: heard, onCrash: giveUp });
    } catch {
      // Why it is safe: the notes are cut in the window instead, which is slower, never wrong.
      gaveUp = true;
      worker = null;
    }
    return worker;
  };

  return async (files) => {
    const on = started();
    if (on === null) return fallback(files);
    const cut: NotePassages[] = [];
    for (const file of files) {
      const id = ++requests;
      try {
        cut.push(
          await new Promise<NotePassages>((resolve, reject) => {
            waiting.set(id, { resolve, reject });
            on.post({ kind: 'chunk', id, file });
          }),
        );
      } catch (cause) {
        // A worker that died is replaced by the window; a note it refused stays refused.
        if (!gaveUp) throw cause;
        return fallback(files);
      }
    }
    return cut;
  };
}

/** A chunker over the markdown reader in the window itself: the worker's fallback. */
export const windowNoteChunker = (markdown: MarkdownPort): NoteChunker => inlineChunker(markdown);
