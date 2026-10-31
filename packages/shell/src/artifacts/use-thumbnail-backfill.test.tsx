// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  fakeIndexPort,
  fakeVaultFs,
  type ThumbnailJob,
  type ThumbnailResult,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useThumbnailBackfill } from './use-thumbnail-backfill.ts';

const ARTIFACTS = ['Chart.md', 'Deck.md', 'Map.md'];

/** Three artifacts with a copy and no cover, and a queue that holds every job until told. */
function setUp() {
  const held: { job: ThumbnailJob; settle: (result: ThumbnailResult | null) => void }[] = [];
  const thumbnails = {
    request: (job: ThumbnailJob) =>
      new Promise<ThumbnailResult | null>((settle) => {
        held.push({ job, settle });
      }),
  };
  const index = fakeIndexPort({
    notesOfType: async () =>
      ARTIFACTS.map((path) => ({ path, title: path, values: {}, modified: 1 })) as never,
  });
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({
      text: `---\ntype: artifact\nsaved: ${path.replace('.md', '')}\n---\n`,
      modified: 1,
    }),
  });
  const hook = renderHook(() =>
    useThumbnailBackfill({ thumbnails, index, fs, markdown: remarkMarkdown }),
  );
  return { hook, held };
}

describe('Generate missing thumbnails, pressed twice before the first press is counted', () => {
  it('never counts below nothing, and says it is done only once every picture is', async () => {
    const { hook, held } = setUp();

    // Both presses land before the vault has been searched and the button disabled.
    act(() => {
      hook.result.current.run();
      hook.result.current.run();
    });
    await waitFor(() => expect(hook.result.current.left).toBe(3));
    // The second press, made while the first was still searching, asks for nothing more.
    await act(async () => {});
    expect(held).toHaveLength(3);

    // Two of the three pictures are made.
    await act(async () => {
      for (const { job, settle } of held) {
        if (job.path !== 'Map.md') settle({ kind: 'made', path: job.path, cover: 'x.png' });
      }
    });
    expect(hook.result.current.left).toBe(1);
    expect(hook.result.current.report).toBeNull();

    await act(async () => {
      const last = held.find(({ job }) => job.path === 'Map.md');
      last?.settle({ kind: 'made', path: last.job.path, cover: 'x.png' });
    });
    expect(hook.result.current.left).toBe(0);
    expect(hook.result.current.report).toBe('Made 3 thumbnails');
  });
});
