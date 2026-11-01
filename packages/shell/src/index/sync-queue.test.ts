import { describe, expect, it } from 'vitest';
import { createSyncQueue, type QueuedSync, type SyncRequest } from './sync-queue.ts';

const REFRESH: SyncRequest = { fromScratch: false, quiet: false };
const QUIET: SyncRequest = { fromScratch: false, quiet: true };
const REBUILD: SyncRequest = { fromScratch: true, quiet: false };

/** A queue over syncs a test lets finish one at a time, remembering each it started. */
function heldQueue() {
  const started: { sync: QueuedSync; finish: (held: boolean) => void; wasLast?: boolean }[] = [];
  const queue = createSyncQueue(
    (sync) =>
      new Promise<boolean>((resolve) => {
        const entry: (typeof started)[number] = {
          sync,
          finish: (held) => {
            entry.wasLast = sync.last();
            resolve(held);
          },
        };
        started.push(entry);
      }),
  );
  return { queue, started };
}

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createSyncQueue (#238)', () => {
  it('starts one sync, and answers every ask made while it runs with one sync after it', async () => {
    const { queue, started } = heldQueue();
    const first = queue.ask('/vaults/Larkspur', REFRESH);
    const behind = [1, 2, 3, 4].map(() => queue.ask('/vaults/Larkspur', QUIET));
    expect(started).toHaveLength(1);
    expect(new Set(behind).size).toBe(1);

    started[0]?.finish(true);
    await first;
    await turn();
    expect(started).toHaveLength(2);
    started[1]?.finish(true);
    expect(await Promise.all(behind)).toEqual([true, true, true, true]);
    expect(started).toHaveLength(2);
  });

  it('is loud, and a rebuild, when any ask that joined the waiting sync was', async () => {
    const { queue, started } = heldQueue();
    void queue.ask('/vaults/Larkspur', QUIET);
    void queue.ask('/vaults/Larkspur', QUIET);
    void queue.ask('/vaults/Larkspur', REBUILD);
    void queue.ask('/vaults/Larkspur', QUIET);

    started[0]?.finish(true);
    await turn();
    expect(started[1]?.sync.request).toEqual({ fromScratch: true, quiet: false });
  });

  it('reads again every note any ask that joined named, each once (#245)', async () => {
    const { queue, started } = heldQueue();
    void queue.ask('/vaults/Larkspur', REFRESH);
    void queue.ask('/vaults/Larkspur', { ...QUIET, recheck: ['Plan.md'] });
    void queue.ask('/vaults/Larkspur', QUIET);
    void queue.ask('/vaults/Larkspur', { ...QUIET, recheck: ['Alder.md', 'Plan.md'] });
    started[0]?.finish(true);
    await turn();
    expect([...(started[1]?.sync.request.recheck ?? [])].sort()).toEqual(['Alder.md', 'Plan.md']);
  });

  it('names no note to read again when no ask that joined did', async () => {
    const { queue, started } = heldQueue();
    void queue.ask('/vaults/Larkspur', REFRESH);
    void queue.ask('/vaults/Larkspur', QUIET);
    void queue.ask('/vaults/Larkspur', REFRESH);
    started[0]?.finish(true);
    await turn();
    expect(started[1]?.sync.request).not.toHaveProperty('recheck');
  });

  it('stays quiet when every ask that joined was quiet', async () => {
    const { queue, started } = heldQueue();
    void queue.ask('/vaults/Larkspur', REFRESH);
    void queue.ask('/vaults/Larkspur', QUIET);
    void queue.ask('/vaults/Larkspur', QUIET);
    started[0]?.finish(true);
    await turn();
    expect(started[1]?.sync.request).toEqual(QUIET);
  });

  it('tells a sync it is not the last while one waits behind it, and the one behind that it is', async () => {
    const { queue, started } = heldQueue();
    void queue.ask('/vaults/Larkspur', REFRESH);
    void queue.ask('/vaults/Larkspur', REFRESH);
    started[0]?.finish(true);
    await turn();
    started[1]?.finish(true);
    await turn();
    expect(started.map((entry) => entry.wasLast)).toEqual([false, true]);
  });

  it('starts another vault at once, and tells the old vault’s sync it is no longer current', async () => {
    const { queue, started } = heldQueue();
    void queue.ask('/vaults/Larkspur', REFRESH);
    void queue.ask('/vaults/Quill', REFRESH);
    expect(started.map((entry) => entry.sync.vault)).toEqual(['/vaults/Larkspur', '/vaults/Quill']);
    expect(started[0]?.sync.current()).toBe(false);
    expect(started[0]?.sync.last()).toBe(false);
    expect(started[1]?.sync.current()).toBe(true);
  });

  it('starts the next ask afresh once a sync has failed', async () => {
    const outcomes = [false, true];
    let runs = 0;
    const queue = createSyncQueue(async () => outcomes[runs++] ?? true);
    expect(await queue.ask('/vaults/Larkspur', REFRESH)).toBe(false);
    expect(await queue.ask('/vaults/Larkspur', REFRESH)).toBe(true);
    expect(runs).toBe(2);
  });
});
