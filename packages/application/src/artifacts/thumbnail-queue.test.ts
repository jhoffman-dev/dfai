import { describe, expect, it } from 'vitest';
import { createVaultPath } from '@dfai/domain';
import type { ThumbnailResult } from './artifact-thumbnail.ts';
import {
  createThumbnailQueue,
  NO_THUMBNAIL_QUEUE,
  NO_THUMBNAILS_HERE,
  type ThumbnailJob,
} from './thumbnail-queue.ts';

const path = (name: string) => createVaultPath(`artifacts/${name}.md`);
const MADE = (name: string): ThumbnailResult => ({
  kind: 'made',
  path: createVaultPath(`artifacts/${name}/atlas-thumbnail.png`),
  cover: `${name}/atlas-thumbnail.png`,
});

/** A generator whose jobs finish only when the test says, in any order. */
function controlled() {
  const started: ThumbnailJob[] = [];
  const pending = new Map<
    string,
    { resolve: (r: ThumbnailResult) => void; reject: (e: Error) => void }
  >();
  const generate = (job: ThumbnailJob) =>
    new Promise<ThumbnailResult>((resolve, reject) => {
      started.push(job);
      pending.set(job.path, { resolve, reject });
    });
  const settle = async (name: string, outcome: ThumbnailResult | Error) => {
    const job = pending.get(path(name));
    if (job === undefined) throw new Error(`${name} is not running`);
    pending.delete(path(name));
    if (outcome instanceof Error) job.reject(outcome);
    else job.resolve(outcome);
    // Let the queue's handlers run.
    await Promise.resolve();
    await Promise.resolve();
  };
  return { started, generate, settle };
}

describe('NO_THUMBNAIL_QUEUE (#657)', () => {
  it('makes nothing and says nothing failed: the card keeps its placeholder', async () => {
    let told = 0;
    const stop = NO_THUMBNAIL_QUEUE.subscribe(() => (told += 1));
    expect(await NO_THUMBNAIL_QUEUE.request({ path: path('a'), asked: true })).toBeNull();
    expect(NO_THUMBNAIL_QUEUE.snapshot().state(path('a'))).toBeNull();
    expect(NO_THUMBNAIL_QUEUE.snapshot().madeInAll()).toBe(0);
    expect(NO_THUMBNAIL_QUEUE.snapshot()).toBe(NO_THUMBNAIL_QUEUE.snapshot());
    expect(told).toBe(0);
    stop();
  });

  it('says why to a caller that must report a failure (the local API)', async () => {
    await expect(
      NO_THUMBNAIL_QUEUE.requestOrFail({ path: path('a'), asked: true }),
    ).rejects.toThrow(NO_THUMBNAILS_HERE);
  });
});

describe('createThumbnailQueue', () => {
  it('makes at most `concurrency` at once, and the rest in the order asked', async () => {
    const { started, generate, settle } = controlled();
    const queue = createThumbnailQueue({ generate, concurrency: 2 });

    for (const name of ['a', 'b', 'c', 'd']) void queue.request({ path: path(name), asked: false });

    expect(started.map((job) => job.path)).toEqual([path('a'), path('b')]);
    await settle('b', MADE('b'));
    expect(started.map((job) => job.path)).toEqual([path('a'), path('b'), path('c')]);
    await settle('a', MADE('a'));
    expect(started.at(-1)?.path).toBe(path('d'));
  });

  it('says which are under way, which failed and why, and counts what was made', async () => {
    const { generate, settle } = controlled();
    const queue = createThumbnailQueue({ generate });
    const seen: unknown[] = [];
    queue.subscribe(() => seen.push(queue.snapshot()));

    const made = queue.request({ path: path('a'), asked: false });
    const failed = queue.request({ path: path('b'), asked: false });
    expect(queue.snapshot().state(path('a'))).toEqual({ kind: 'generating' });
    expect(queue.snapshot().madeInAll()).toBe(0);
    expect(queue.snapshot().made(path('a'))).toBe(0);

    await settle('a', MADE('a'));
    await settle('b', new Error('the page took too long to load'));

    await expect(made).resolves.toEqual(MADE('a'));
    await expect(failed).resolves.toBeNull();
    expect(queue.snapshot().state(path('a'))).toBeNull();
    expect(queue.snapshot().made(path('a'))).toBe(1);
    expect(queue.snapshot().state(path('b'))).toEqual({
      kind: 'failed',
      reason: 'the page took too long to load',
    });
    expect(queue.snapshot().made(path('b'))).toBe(0);
    // Of any note: what tells a reader of the cache that a picture was kept.
    expect(queue.snapshot().madeInAll()).toBe(1);
    // A new snapshot for every change, and the same one between them.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(new Set(seen).size).toBe(seen.length);
    expect(queue.snapshot()).toBe(queue.snapshot());
  });

  it('tells a caller that must say why the error itself, and one joined to it the null', async () => {
    const { generate, settle } = controlled();
    const queue = createThumbnailQueue({ generate, concurrency: 1 });
    const refused = new Error('There is no saved copy to picture');

    // 'b' holds the one slot, so both asks for 'a' wait together.
    void queue.request({ path: path('b'), asked: false });
    const answered = queue.requestOrFail({ path: path('a'), asked: false });
    const joined = queue.request({ path: path('a'), asked: false });
    await settle('b', MADE('b'));
    await settle('a', refused);

    await expect(answered).rejects.toBe(refused);
    await expect(joined).resolves.toBeNull();
    expect(queue.snapshot().state(path('a'))).toEqual({
      kind: 'failed',
      reason: 'There is no saved copy to picture',
    });
  });

  it('hands a caller that must say why the result when it is made', async () => {
    const { generate, settle } = controlled();
    const queue = createThumbnailQueue({ generate });
    const answered = queue.requestOrFail({ path: path('a'), asked: false });
    await settle('a', MADE('a'));
    await expect(answered).resolves.toEqual(MADE('a'));
  });

  it('counts nothing made when the cover was kept', async () => {
    const { generate, settle } = controlled();
    const queue = createThumbnailQueue({ generate });
    void queue.request({ path: path('a'), asked: false });
    await settle('a', { kind: 'kept' });
    expect(queue.snapshot().made(path('a'))).toBe(0);
    expect(queue.snapshot().state(path('a'))).toBeNull();
  });

  it('joins a request to one still waiting, made as asked if either asked', async () => {
    const { started, generate, settle } = controlled();
    const queue = createThumbnailQueue({ generate, concurrency: 1 });

    void queue.request({ path: path('a'), asked: false });
    const first = queue.request({ path: path('b'), asked: false });
    const second = queue.request({ path: path('b'), asked: true });
    await settle('a', MADE('a'));

    expect(started.map((job) => [job.path, job.asked])).toEqual([
      [path('a'), false],
      [path('b'), true],
    ]);
    await settle('b', MADE('b'));
    await expect(first).resolves.toEqual(MADE('b'));
    await expect(second).resolves.toEqual(MADE('b'));
  });

  it('makes one again, after, when asked while it is under way', async () => {
    const { started, generate, settle } = controlled();
    const queue = createThumbnailQueue({ generate, concurrency: 2 });

    void queue.request({ path: path('a'), asked: false });
    void queue.request({ path: path('a'), asked: true });
    expect(started).toHaveLength(1);

    await settle('a', MADE('a'));
    expect(started.map((job) => job.asked)).toEqual([false, true]);
    expect(queue.snapshot().state(path('a'))).toEqual({ kind: 'generating' });
    await settle('a', MADE('a'));
    expect(queue.snapshot().made(path('a'))).toBe(2);
    expect(queue.snapshot().state(path('a'))).toBeNull();
  });

  it('stops telling a listener once it unsubscribes', () => {
    const queue = createThumbnailQueue({ generate: () => new Promise(() => undefined) });
    let calls = 0;
    const stop = queue.subscribe(() => (calls += 1));
    void queue.request({ path: path('a'), asked: false });
    stop();
    void queue.request({ path: path('b'), asked: false });
    expect(calls).toBe(1);
  });
});
