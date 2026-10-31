// @vitest-environment jsdom
/**
 * Attacks on keeping pages' pictures fresh (U-15).
 *
 * The gallery and a note's pane each keep the pictures they show fresh, over
 * one shared queue. The module claims "each version of a note is asked for
 * once". Every picture is a web page loaded in a process of its own, so a
 * version pictured twice is real work thrown away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createVaultPath, pageThumbnailPath } from '@dfai/domain';
import { createThumbnailQueue, type ThumbnailJob } from '@dfai/application';
import { usePageThumbnailRefresh, type PageToPicture } from './use-page-thumbnails.ts';

const DUNE = createVaultPath('Books/Dune.md');
const NOW = 10_000_000;

describe('usePageThumbnailRefresh, from the gallery and a pane at once', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pictures one version of a note once, however many surfaces show it', async () => {
    const jobs: ThumbnailJob[] = [];
    let finish: () => void = () => {};
    const queue = createThumbnailQueue({
      generate: (job) => {
        jobs.push(job);
        // A picture takes a while: the second surface asks while it is under way.
        return new Promise((resolve) => {
          finish = () => resolve({ kind: 'made', path: pageThumbnailPath(job.path), cover: '' });
        });
      },
    });
    const pages: readonly PageToPicture[] = [{ path: DUNE, modified: NOW - 1 }];
    const pictured = new Map<string, number>();

    renderHook(() => {
      // The gallery listing Dune, and the pane Dune is open in.
      usePageThumbnailRefresh({ pages, pictured, thumbnails: queue, now: () => NOW });
      usePageThumbnailRefresh({ pages, pictured, thumbnails: queue, now: () => NOW });
    });
    await act(async () => {
      finish();
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      finish();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(jobs).toEqual([{ path: DUNE, asked: false }]);
  });
});
