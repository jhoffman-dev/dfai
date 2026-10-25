import { describe, expect, it } from 'vitest';
import { inlineChunker, notePassages, type NoteFile } from '@dfai/application';
import { remarkMarkdown } from '../markdown/markdown-port.ts';
import {
  isChunkRequest,
  serveNoteChunking,
  workerNoteChunker,
  type ChunkWorker,
} from './note-chunking.ts';

const file = (path: string, text: string): NoteFile => ({
  path,
  text,
  modified: 1,
  size: text.length,
});
const STANDUP = file(
  'Meetings/Standup.md',
  '# Standup\n\nMara Quill moves payday to Friday.\n\n- Printer broken\n',
);

/** A worker in this thread: the worker's half serving the window's, as a real one does across threads. */
function inProcessWorker(overrides: Partial<ChunkWorker> = {}): ChunkWorker & { posted: number } {
  let answer: (answer: unknown) => void = () => undefined;
  const serve = serveNoteChunking({
    markdown: remarkMarkdown,
    // Structured clone, as postMessage does: what comes back is plain data.
    answer: (reply) => queueMicrotask(() => answer(structuredClone(reply))),
  });
  const worker = {
    posted: 0,
    post(request: Parameters<ChunkWorker['post']>[0]) {
      worker.posted += 1;
      serve(structuredClone(request));
    },
    listen: ({ onAnswer }: Parameters<ChunkWorker['listen']>[0]) => {
      answer = onAnswer;
    },
    ...overrides,
  };
  return worker;
}

const fallback = inlineChunker(remarkMarkdown);

describe('workerNoteChunker', () => {
  it('gives the passages the window would have made, parsed in the worker', async () => {
    const worker = inProcessWorker();
    const chunker = workerNoteChunker(() => worker, { fallback });
    const [passages] = await chunker([STANDUP]);
    expect(passages).toEqual(notePassages(STANDUP, remarkMarkdown));
    expect(worker.posted).toBe(1);
  });

  it('refuses a note the worker could not cut, in the worker’s words, and goes on to the next', async () => {
    const poison: ChunkWorker = {
      post: () => undefined,
      listen: () => undefined,
    };
    let answer: (answer: unknown) => void = () => undefined;
    const worker: ChunkWorker = {
      ...poison,
      listen: ({ onAnswer }) => {
        answer = onAnswer;
      },
      post: ({ id }) => {
        answer({ kind: 'chunk-refused', id, problem: 'the markdown reader stopped' });
      },
    };
    const chunker = workerNoteChunker(() => worker, { fallback });
    await expect(chunker([STANDUP])).rejects.toThrow('the markdown reader stopped');
  });

  it('cuts in the window from then on when the worker dies, and answers the note it died on', async () => {
    let crash: (problem: string) => void = () => undefined;
    const dying: ChunkWorker = {
      post: () => crash('the chunking worker stopped'),
      listen: ({ onCrash }) => {
        crash = onCrash;
      },
    };
    const chunker = workerNoteChunker(() => dying, { fallback });
    const [first] = await chunker([STANDUP]);
    expect(first).toEqual(notePassages(STANDUP, remarkMarkdown));
    const [second] = await chunker([STANDUP]);
    expect(second).toEqual(first);
  });

  it('cuts in the window when the worker cannot be started', async () => {
    const chunker = workerNoteChunker(
      () => {
        throw new Error('no workers here');
      },
      { fallback },
    );
    expect((await chunker([STANDUP]))[0]?.chunks.length).toBeGreaterThan(0);
  });

  it('tells a chunking request from the index worker’s own', async () => {
    const worker = inProcessWorker();
    const chunker = workerNoteChunker(() => worker, { fallback });
    await chunker([STANDUP]);
    expect(isChunkRequest({ kind: 'begin' })).toBe(false);
    expect(isChunkRequest({ kind: 'chunk', id: 1, file: STANDUP })).toBe(true);
  });
});

describe('what an Obsidian %% comment hides, through the real markdown reader', () => {
  const words = (text: string) =>
    notePassages(file('Review/Tobias Fenn.md', text), remarkMarkdown).chunks.map(
      (chunk) => chunk.words,
    );

  it('hides a callout inside an open comment, its title too', () => {
    const text = [
      'Shown before.',
      '',
      '%% private notes for the review',
      '',
      '> [!note] Salary 91,000 for Tobias Fenn',
      '> Raise agreed with Mara Quill.',
      '',
      'end of it %%',
      '',
      'Shown after.',
    ].join('\n');
    const all = words(text);
    expect(all).toEqual(['Shown before.', 'Shown after.']);
  });

  it('counts a %% that sits in a mark of its own: what follows it is hidden until the next', () => {
    const text = [
      'Payday **%%** moves to Friday for Ida Brenwick%% as planned.',
      '',
      'Shown after.',
    ].join('\n');
    expect(words(text)).toEqual(['Payday as planned.', 'Shown after.']);
  });

  it('does not count two % that markup keeps apart, as Obsidian reads the source', () => {
    // `*%*%` has no `%%` in what is written, so Obsidian opens no comment, and neither does this.
    const text = [
      'Larkspur Payroll fees rose *%*% this year.',
      '',
      'Tobias Fenn owes 91,000.',
    ].join('\n');
    expect(words(text)).toEqual([
      'Larkspur Payroll fees rose %% this year.',
      'Tobias Fenn owes 91,000.',
    ]);
  });
});
