import type { VaultPath } from '@dfai/domain';
import type { ThumbnailResult } from './artifact-thumbnail.ts';

/** One thumbnail to make: whose, and whether the person asked (Regenerate). */
export interface ThumbnailJob {
  readonly path: VaultPath;
  readonly asked: boolean;
}

/** Where an artifact's thumbnail is: null when nothing is under way or went wrong. */
export type ThumbnailState =
  { readonly kind: 'generating' } | { readonly kind: 'failed'; readonly reason: string };

/**
 * The queue as it stands: which thumbnails are under way, which failed and
 * why, and how many times each has been made — so a picture made again under
 * the same name is loaded again. A new one each time anything changes, so it
 * can be compared by identity.
 */
export interface ThumbnailSnapshot {
  state(path: string): ThumbnailState | null;
  /** How many thumbnails have been made for the note since the queue began. */
  made(path: string): number;
  /** How many thumbnails have been made since the queue began, of any note. */
  madeInAll(): number;
}

/** Thumbnails being made, a few at a time. */
export interface ThumbnailQueue {
  /**
   * Makes a note's thumbnail when a slot is free. Asking for one already
   * waiting joins it — made as asked if either asked. Asking for one under
   * way makes it again once that is done, since the copy may have changed.
   * Settles with how it ended; never rejects: a failure is its state.
   */
  request(job: ThumbnailJob): Promise<ThumbnailResult | null>;
  /**
   * The same, for a caller that has to say why it failed (the local API):
   * rejects with the error making it rejected with.
   */
  requestOrFail(job: ThumbnailJob): Promise<ThumbnailResult>;
  /** The queue now; the same object until something changes. */
  snapshot(): ThumbnailSnapshot;
  subscribe(listener: () => void): () => void;
}

/** What asking a queue that makes nothing says. */
export const NO_THUMBNAILS_HERE = 'No thumbnail can be made on this platform.';

const NOTHING_MADE: ThumbnailSnapshot = Object.freeze({
  state: () => null,
  made: () => 0,
  madeInAll: () => 0,
});

/**
 * A queue that makes nothing, for a platform that cannot picture a page
 * (ADR-0051): every card keeps its placeholder, and nothing is said to fail.
 */
export const NO_THUMBNAIL_QUEUE: ThumbnailQueue = Object.freeze({
  request: async () => null,
  requestOrFail: async () => {
    throw new Error(NO_THUMBNAILS_HERE);
  },
  snapshot: () => NOTHING_MADE,
  subscribe: () => () => {},
});

/** How many pictures are made at once: each is a web page loaded in a process of its own. */
export const THUMBNAIL_CONCURRENCY = 2;

/** How one making ended: its result, or what it failed with. */
type Outcome =
  { readonly result: ThumbnailResult } | { readonly result: null; readonly error: unknown };

interface Waiting {
  asked: boolean;
  settle: ((outcome: Outcome) => void)[];
}

/** A queue that makes each thumbnail with `generate`, `concurrency` at a time. */
export function createThumbnailQueue({
  generate,
  concurrency = THUMBNAIL_CONCURRENCY,
}: {
  generate: (job: ThumbnailJob) => Promise<ThumbnailResult>;
  concurrency?: number;
}): ThumbnailQueue {
  const waiting = new Map<VaultPath, Waiting>();
  const running = new Set<string>();
  const states = new Map<string, ThumbnailState>();
  const counts = new Map<string, number>();
  const listeners = new Set<() => void>();
  const snapshotNow = (): ThumbnailSnapshot => {
    const stateNow = new Map(states);
    const countsNow = new Map(counts);
    const inAll = [...counts.values()].reduce((sum, count) => sum + count, 0);
    return {
      state: (path) => stateNow.get(path) ?? null,
      made: (path) => countsNow.get(path) ?? 0,
      madeInAll: () => inAll,
    };
  };
  let current = snapshotNow();

  const changed = () => {
    current = snapshotNow();
    for (const listener of listeners) listener();
  };

  const run = (path: VaultPath, { asked, settle }: Waiting) => {
    running.add(path);
    const finish = (outcome: Outcome, state: ThumbnailState | null) => {
      const { result } = outcome;
      running.delete(path);
      if (state === null) states.delete(path);
      else states.set(path, state);
      if (result?.kind === 'made') counts.set(path, (counts.get(path) ?? 0) + 1);
      // Asked for again while this ran: it is still waiting, so still under way.
      if (waiting.has(path)) states.set(path, { kind: 'generating' });
      for (const done of settle) done(outcome);
      changed();
      pump();
    };
    generate({ path, asked }).then(
      (result) => finish({ result }, null),
      (error: unknown) =>
        finish(
          { result: null, error },
          {
            kind: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          },
        ),
    );
  };

  const pump = () => {
    for (const [path, job] of waiting) {
      if (running.size >= concurrency) return;
      if (running.has(path)) continue;
      waiting.delete(path);
      run(path, job);
    }
  };

  const enqueue = ({ path, asked }: ThumbnailJob) =>
    new Promise<Outcome>((settle) => {
      const joined = waiting.get(path);
      if (joined === undefined) waiting.set(path, { asked, settle: [settle] });
      else {
        joined.asked ||= asked;
        joined.settle.push(settle);
      }
      states.set(path, { kind: 'generating' });
      changed();
      pump();
    });

  return {
    request: (job) => enqueue(job).then(({ result }) => result),
    requestOrFail: (job) =>
      enqueue(job).then((outcome) => {
        if (outcome.result === null) throw outcome.error;
        return outcome.result;
      }),
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
