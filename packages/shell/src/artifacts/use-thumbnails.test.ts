// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createVaultPath } from '@dfai/domain';
import type { ThumbnailQueue } from '@dfai/application';
import { useThumbnailsNow } from './use-thumbnails.ts';

const JOB = { path: createVaultPath('artifacts/Q3.md'), asked: false };

function queueNamed(cover: string): Pick<ThumbnailQueue, 'requestOrFail'> {
  return {
    requestOrFail: vi.fn(async (job) => ({ kind: 'made', path: job.path, cover }) as const),
  };
}

describe('useThumbnailsNow, for the local API', () => {
  it('stays the same object when the vault, and so the queue, changes', async () => {
    const first = queueNamed('first.png');
    const second = queueNamed('second.png');
    const hook = renderHook(({ queue }) => useThumbnailsNow(queue), {
      initialProps: { queue: first },
    });
    const given = hook.result.current;

    hook.rerender({ queue: second });

    // The API serves once for the life of the app, so what it holds must not change…
    expect(hook.result.current).toBe(given);
    // …and asks the queue of the vault open when the request arrives.
    await expect(given.requestOrFail(JOB)).resolves.toMatchObject({ cover: 'second.png' });
    expect(first.requestOrFail).not.toHaveBeenCalled();
  });
});
