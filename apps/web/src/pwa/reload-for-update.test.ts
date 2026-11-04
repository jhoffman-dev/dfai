import { describe, expect, it, vi } from 'vitest';
import { reloadForUpdate, TAKE_OVER_WAIT_MS } from './reload-for-update.ts';

/** A promise the test settles. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** The save queue's lock as the test watches it: whether it is held, and a task's turn. */
function watchedLock() {
  const lock = {
    held: false,
    task: async (task: () => Promise<void>) => {
      lock.held = true;
      try {
        await task();
      } finally {
        lock.held = false;
      }
    },
  };
  return lock;
}

/** Everything the reload needs, taking over at once unless the test says otherwise. */
function deps(over: Partial<Parameters<typeof reloadForUpdate>[0]> = {}) {
  return {
    writeAutosave: async () => [],
    lock: (task: () => Promise<void>) => task(),
    takeOver: async () => {},
    reloadPage: vi.fn(),
    wait: () => new Promise<void>(() => {}),
    report: vi.fn(),
    ...over,
  };
}

describe('reloading into a newer build (#668)', () => {
  it("writes the panes' autosave into the queue before the worker takes over", async () => {
    const order: string[] = [];
    await reloadForUpdate(
      deps({
        writeAutosave: async () => {
          order.push('written');
          return [];
        },
        lock: async (task) => {
          order.push('locked');
          await task();
          order.push('unlocked');
        },
        takeOver: async () => void order.push('taken over'),
        reloadPage: () => order.push('reloaded'),
      }),
    );
    expect(order).toEqual(['written', 'locked', 'taken over', 'reloaded', 'unlocked']);
  });

  it('holds the save queue’s lock from before the takeover until the reload, so no send starts between', async () => {
    const lock = watchedLock();
    const taking = deferred();
    let heldAtTakeOver: boolean | null = null;
    let heldAtReload: boolean | null = null;
    const reloading = reloadForUpdate(
      deps({
        lock: lock.task,
        takeOver: () => {
          heldAtTakeOver = lock.held;
          return taking.promise;
        },
        reloadPage: () => (heldAtReload = lock.held),
      }),
    );
    await Promise.resolve();
    expect(heldAtTakeOver).toBe(true);
    expect(lock.held).toBe(true);
    taking.resolve();
    expect(await reloading).toBe('reloaded');
    expect(heldAtReload).toBe(true);
    expect(lock.held).toBe(false);
  });

  it('gives the lock back and leaves the bar up when the worker does not take over in time', async () => {
    const lock = watchedLock();
    const timeout = deferred();
    const reloadPage = vi.fn();
    const waited: number[] = [];
    const reloading = reloadForUpdate(
      deps({
        lock: lock.task,
        takeOver: () => new Promise(() => {}),
        reloadPage,
        wait: (ms) => {
          waited.push(ms);
          return timeout.promise;
        },
      }),
    );
    await Promise.resolve();
    expect(lock.held).toBe(true);
    timeout.resolve();
    expect(await reloading).toBe('timed-out');
    expect(reloadPage).not.toHaveBeenCalled();
    expect(lock.held).toBe(false);
    expect(waited).toEqual([TAKE_OVER_WAIT_MS]);
  });

  it('reports a pane that could not write, and reloads all the same: the queue has the rest', async () => {
    const report = vi.fn();
    const reloadPage = vi.fn();
    const failed = new Error('the editor is gone');
    await reloadForUpdate(deps({ writeAutosave: async () => [failed], reloadPage, report }));
    expect(report).toHaveBeenCalledWith(failed);
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('does not take over or reload when the lock is refused: a reload mid-send is the one thing to avoid', async () => {
    const takeOver = vi.fn(async () => {});
    const reloadPage = vi.fn();
    await expect(
      reloadForUpdate(
        deps({ lock: () => Promise.reject(new Error('no Web Locks here')), takeOver, reloadPage }),
      ),
    ).rejects.toThrow('no Web Locks here');
    expect(takeOver).not.toHaveBeenCalled();
    expect(reloadPage).not.toHaveBeenCalled();
  });
});
