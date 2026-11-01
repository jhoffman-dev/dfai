import { describe, expect, it } from 'vitest';
import { createPendingWrites } from './pending-writes.ts';

/** A promise settled by hand, and whether it has. */
function later(): { promise: Promise<void>; resolve: () => void; settled: () => boolean } {
  let settled = false;
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = () => {
      settled = true;
      done();
    };
  });
  return { promise, resolve, settled: () => settled };
}

/** Whether `promise` has settled by the next turn of the event loop, without waiting longer. */
async function settledNow(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((turn) => setTimeout(turn, 0));
  return settled;
}

describe('createPendingWrites', () => {
  it('settles at once with nothing held', async () => {
    const writes = createPendingWrites();
    expect(await settledNow(writes.drained())).toBe(true);
  });

  it('waits for every page that holds writes, each asked as the settle begins', async () => {
    const writes = createPendingWrites();
    const inbox = later();
    const proposals = later();
    writes.hold(() => inbox.promise);
    writes.hold(() => proposals.promise);
    const settle = writes.drained();
    expect(await settledNow(settle)).toBe(false);
    inbox.resolve();
    expect(await settledNow(settle)).toBe(false);
    proposals.resolve();
    expect(await settledNow(settle)).toBe(true);
  });

  it('keeps waiting for what a page was writing as it went, once, and no longer after', async () => {
    const writes = createPendingWrites();
    const inFlight = later();
    let asked = 0;
    const release = writes.hold(() => {
      asked += 1;
      return inFlight.promise;
    });
    // The page unmounts mid-write: its last word is read as it goes, not asked for again.
    release();
    expect(asked).toBe(1);
    const settle = writes.drained();
    expect(asked).toBe(1);
    expect(await settledNow(settle)).toBe(false);
    inFlight.resolve();
    expect(await settledNow(settle)).toBe(true);
    // Drained, the departed page holds nothing more.
    expect(await settledNow(writes.drained())).toBe(true);
    expect(asked).toBe(1);
  });

  it('lets go of a page that was holding nothing when it went', async () => {
    const writes = createPendingWrites();
    const release = writes.hold(() => Promise.resolve());
    release();
    await Promise.resolve();
    const slow = later();
    writes.hold(() => slow.promise);
    const settle = writes.drained();
    expect(await settledNow(settle)).toBe(false);
    slow.resolve();
    expect(await settledNow(settle)).toBe(true);
  });
});
