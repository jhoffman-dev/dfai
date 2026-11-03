import { describe, expect, it, vi } from 'vitest';
import { reloadForUpdate } from './reload-for-update.ts';

describe('reloading into a newer build (#668)', () => {
  it("writes the panes' autosave into the queue before the worker takes over", async () => {
    const order: string[] = [];
    await reloadForUpdate({
      writeAutosave: async () => {
        order.push('written');
        return [];
      },
      lock: async (task) => {
        order.push('locked');
        await task();
        order.push('unlocked');
      },
      takeOver: () => order.push('take over'),
      report: vi.fn(),
    });
    expect(order).toEqual(['written', 'locked', 'take over', 'unlocked']);
  });

  it('tells the worker to take over only under the save queue’s lock, so no send is mid-turn', async () => {
    let held = false;
    let takenOverWhileHeld: boolean | null = null;
    await reloadForUpdate({
      writeAutosave: async () => [],
      lock: async (task) => {
        held = true;
        await task();
        held = false;
      },
      takeOver: () => (takenOverWhileHeld = held),
      report: vi.fn(),
    });
    expect(takenOverWhileHeld).toBe(true);
  });

  it('reports a pane that could not write, and reloads all the same: the queue has the rest', async () => {
    const report = vi.fn();
    const takeOver = vi.fn();
    const failed = new Error('the editor is gone');
    await reloadForUpdate({
      writeAutosave: async () => [failed],
      lock: (task) => task(),
      takeOver,
      report,
    });
    expect(report).toHaveBeenCalledWith(failed);
    expect(takeOver).toHaveBeenCalledTimes(1);
  });

  it('does not take over when the lock is refused: a reload mid-send is the one thing to avoid', async () => {
    const takeOver = vi.fn();
    await expect(
      reloadForUpdate({
        writeAutosave: async () => [],
        lock: () => Promise.reject(new Error('no Web Locks here')),
        takeOver,
        report: vi.fn(),
      }),
    ).rejects.toThrow('no Web Locks here');
    expect(takeOver).not.toHaveBeenCalled();
  });
});
