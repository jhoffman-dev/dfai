// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  createVaultPath,
  PAGE_THUMBNAIL_QUIET_MS,
  pageThumbnailPath,
  pageThumbnailRecord,
  pageThumbnailRecordPath,
  pageThumbnailSrc,
} from '@dfai/domain';
import { createThumbnailQueue, fakeVaultFs, type ThumbnailJob } from '@dfai/application';
import {
  pagePictureSrc,
  usePageThumbnailRefresh,
  usePicturedPages,
  type PageToPicture,
} from './use-page-thumbnails.ts';

const DUNE = createVaultPath('Dune.md');
const EMMA = createVaultPath('Emma.md');
const NOW = 10_000_000;

function queueThat() {
  const jobs: ThumbnailJob[] = [];
  const queue = createThumbnailQueue({
    generate: async (job) => {
      jobs.push(job);
      return { kind: 'made', path: pageThumbnailPath(job.path), cover: '' };
    },
  });
  return { queue, jobs };
}

function refresh({
  pages,
  pictured,
  now = () => NOW,
}: {
  pages: readonly PageToPicture[];
  pictured: ReadonlyMap<string, number> | null;
  now?: () => number;
}) {
  const { queue, jobs } = queueThat();
  const hook = renderHook(
    (props: { pages: readonly PageToPicture[]; pictured: ReadonlyMap<string, number> | null }) =>
      usePageThumbnailRefresh({ ...props, thumbnails: queue, now }),
    { initialProps: { pages, pictured } },
  );
  return { hook, jobs, queue };
}

describe('usePageThumbnailRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for a page with no picture at once, unasked, and for a fresh one never', async () => {
    // Emma's picture is of the version she is now.
    const pictured = new Map([[pageThumbnailPath(EMMA), NOW - 1]]);
    const { jobs } = refresh({
      pages: [
        { path: DUNE, modified: NOW - 1 },
        { path: EMMA, modified: NOW - 1 },
      ],
      pictured,
    });
    await vi.waitFor(() => expect(jobs).toEqual([{ path: DUNE, asked: false }]));
  });

  it('asks for nothing until the cache has been read', () => {
    const { jobs } = refresh({ pages: [{ path: DUNE, modified: 1 }], pictured: null });
    expect(jobs).toEqual([]);
  });

  it('waits for a note that just changed to rest', async () => {
    let clock = NOW;
    const pass = async (ms: number) => {
      clock += ms;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    const pictured = new Map([[pageThumbnailPath(DUNE), NOW - 60_000]]);
    const { jobs } = refresh({
      pages: [{ path: DUNE, modified: NOW - 1_000 }],
      pictured,
      now: () => clock,
    });
    expect(jobs).toEqual([]);
    await pass(PAGE_THUMBNAIL_QUIET_MS - 1_000 - 1);
    expect(jobs).toEqual([]);
    await pass(1);
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
  });

  it('asks once for each version of a note, even when the cache has not caught up', async () => {
    const pictured = new Map<string, number>();
    const { hook, jobs } = refresh({ pages: [{ path: DUNE, modified: 5 }], pictured });
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    hook.rerender({ pages: [{ path: DUNE, modified: 5 }], pictured: new Map() });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAGE_THUMBNAIL_QUIET_MS * 2);
    });
    expect(jobs).toHaveLength(1);
    hook.rerender({ pages: [{ path: DUNE, modified: 6 }], pictured: new Map() });
    await vi.waitFor(() => expect(jobs).toHaveLength(2));
  });
});

describe('usePicturedPages', () => {
  /** A cache holding Dune's picture, whose record says the version it is of: how many times it was listed. */
  function cacheListed() {
    let listed = 0;
    const record = pageThumbnailRecordPath(DUNE);
    const fs = fakeVaultFs({
      listDirectory: async () => {
        listed += 1;
        return [pageThumbnailPath(DUNE), record].map((path) => ({
          kind: 'file' as const,
          name: path.split('/').at(-1) ?? '',
          path,
        }));
      },
      readNotes: async (paths) =>
        paths.map((path) => {
          const text = pageThumbnailRecord(listed);
          return { path, text, modified: 0, size: text.length };
        }),
    });
    return { fs, listings: () => listed };
  }

  it('reads the cache, and again once the queue has made a picture', async () => {
    const { fs } = cacheListed();
    const { queue } = queueThat();
    const hook = renderHook(() => usePicturedPages(fs, queue));
    expect(hook.result.current).toBeNull();
    await waitFor(() => expect(hook.result.current?.get(pageThumbnailPath(DUNE))).toBe(1));
    await act(async () => {
      await queue.request({ path: DUNE, asked: false });
    });
    await waitFor(() =>
      expect(hook.result.current?.get(pageThumbnailPath(DUNE))).toBeGreaterThan(1),
    );
  });

  it('does not read it again for a picture only asked for, or one that failed', async () => {
    const { fs, listings } = cacheListed();
    let fail: (reason: Error) => void = () => {};
    const queue = createThumbnailQueue({
      generate: () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    });
    const hook = renderHook(() => usePicturedPages(fs, queue));
    await waitFor(() => expect(hook.result.current).not.toBeNull());
    expect(listings()).toBe(1);

    await act(async () => {
      void queue.request({ path: DUNE, asked: false });
      await Promise.resolve();
    });
    expect(queue.snapshot().state(DUNE)).toEqual({ kind: 'generating' });
    await act(async () => {
      fail(new Error('the host could not picture it'));
      await Promise.resolve();
    });
    expect(queue.snapshot().state(DUNE)).toMatchObject({ kind: 'failed' });
    expect(listings()).toBe(1);
  });
});

describe('pagePictureSrc', () => {
  const none = { state: () => null, made: () => 0, madeInAll: () => 0 };

  it('is nothing until there is a picture', () => {
    expect(pagePictureSrc({ path: DUNE, pictured: null, queue: none })).toBeNull();
    expect(pagePictureSrc({ path: DUNE, pictured: new Map(), queue: none })).toBeNull();
  });

  it('is the cached picture, marked each time it is made again', () => {
    const pictured = new Map([[pageThumbnailPath(DUNE), 1]]);
    expect(pagePictureSrc({ path: DUNE, pictured, queue: none })).toBe(pageThumbnailSrc(DUNE));
    expect(
      pagePictureSrc({ path: DUNE, pictured: new Map(), queue: { ...none, made: () => 2 } }),
    ).toBe(`${pageThumbnailSrc(DUNE)}#2`);
  });
});
