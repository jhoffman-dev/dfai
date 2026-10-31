import { describe, expect, it, vi } from 'vitest';
import { closingInStages } from './closing-stages.ts';

function fakeClosing() {
  const handlers: (() => Promise<void>)[] = [];
  return {
    handlers,
    port: {
      beforeClose: async (task: () => Promise<void>) => {
        handlers.push(task);
        return () => {};
      },
    },
  };
}

describe('closingInStages', () => {
  it('registers one handler, and runs every first task before any last one', async () => {
    const { handlers, port } = fakeClosing();
    const stages = closingInStages(port);
    const order: string[] = [];
    const finishSync: { now: (() => void) | null } = { now: null };
    await stages.last.beforeClose(async () => void order.push('flush log'));
    await stages.first.beforeClose(
      () =>
        new Promise<void>((resolve) => {
          finishSync.now = () => {
            order.push('sync');
            resolve();
          };
        }),
    );
    expect(handlers).toHaveLength(1);
    const closing = handlers[0]?.();
    // The sync has begun, and the log waits for it.
    await vi.waitUntil(() => finishSync.now !== null);
    expect(order).toEqual([]);
    finishSync.now?.();
    await closing;
    expect(order).toEqual(['sync', 'flush log']);
  });

  it('writes what is still being written before the sync, and the sync before the log', async () => {
    const { handlers, port } = fakeClosing();
    const stages = closingInStages(port);
    const order: string[] = [];
    const finishAnswers: { now: (() => void) | null } = { now: null };
    await stages.last.beforeClose(async () => void order.push('flush log'));
    await stages.first.beforeClose(async () => void order.push('sync'));
    await stages.writes.beforeClose(
      () =>
        new Promise<void>((resolve) => {
          finishAnswers.now = () => {
            order.push('answers');
            resolve();
          };
        }),
    );
    expect(handlers).toHaveLength(1);
    const closing = handlers[0]?.();
    await vi.waitUntil(() => finishAnswers.now !== null);
    await new Promise((settle) => setTimeout(settle, 0));
    expect(order).toEqual([]);
    finishAnswers.now?.();
    await closing;
    expect(order).toEqual(['answers', 'sync', 'flush log']);
  });

  it('still runs the last stage when a first task fails, and forgets a task that stops', async () => {
    const { handlers, port } = fakeClosing();
    const stages = closingInStages(port);
    const order: string[] = [];
    const stop = await stages.first.beforeClose(async () => void order.push('stopped'));
    await stages.first.beforeClose(async () => {
      throw new Error('offline');
    });
    await stages.last.beforeClose(async () => void order.push('flush log'));
    stop();
    await handlers[0]?.();
    expect(order).toEqual(['flush log']);
  });
});
