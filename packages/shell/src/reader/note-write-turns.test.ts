import { describe, expect, it } from 'vitest';
import { noteWriteTurns } from './note-write-turns.ts';

/*
 * A note's writes take turns (#880): the second waits for the first to land,
 * then runs, so it reads the note the first wrote rather than the one before.
 */

/** A write held until `release` or `refuse` is called, saying whether it has started. */
function heldWrite<T>(value: T) {
  let release: () => void = () => {};
  let refuse: (cause: Error) => void = () => {};
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    refuse = reject;
  });
  let started = false;
  const write = async () => {
    started = true;
    await gate;
    return value;
  };
  return {
    write,
    release,
    refuse,
    get started() {
      return started;
    },
  };
}

/** Lets every promise already settled run its callbacks. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("a note's writes", () => {
  it('run one after the other, and both succeed', async () => {
    const turns = noteWriteTurns();
    const first = heldWrite('first');
    const second = heldWrite('second');
    const firstDone = turns.take('a.md', first.write);
    const secondDone = turns.take('a.md', second.write);
    await settled();
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);

    first.release();
    await expect(firstDone).resolves.toBe('first');
    await settled();
    expect(second.started).toBe(true);
    second.release();
    await expect(secondDone).resolves.toBe('second');
  });

  it('carry on after one fails, which rejects only its own caller', async () => {
    const turns = noteWriteTurns();
    const first = heldWrite('first');
    const second = heldWrite('second');
    const firstDone = turns.take('a.md', first.write);
    const secondDone = turns.take('a.md', second.write);

    first.refuse(new Error('the note changed on disk since it was opened'));
    await expect(firstDone).rejects.toThrow('the note changed on disk since it was opened');
    await settled();
    expect(second.started).toBe(true);
    second.release();
    await expect(secondDone).resolves.toBe('second');
  });

  it('of two notes do not wait on each other', async () => {
    const turns = noteWriteTurns();
    const one = heldWrite('one');
    const other = heldWrite('other');
    const oneDone = turns.take('a.md', one.write);
    const otherDone = turns.take('b.md', other.write);
    await settled();
    expect(one.started).toBe(true);
    expect(other.started).toBe(true);

    other.release();
    await expect(otherDone).resolves.toBe('other');
    one.release();
    await expect(oneDone).resolves.toBe('one');
  });

  it('leave nothing waiting once they have landed or failed', async () => {
    const turns = noteWriteTurns();
    const landed = heldWrite('landed');
    const failed = heldWrite('failed');
    const landedDone = turns.take('a.md', landed.write);
    const failedDone = turns.take('a.md', failed.write);
    expect(turns.busy('a.md')).toBe(true);

    landed.release();
    await landedDone;
    expect(turns.busy('a.md')).toBe(true);
    await settled();
    failed.refuse(new Error('disk gone'));
    await expect(failedDone).rejects.toThrow('disk gone');
    await settled();
    expect(turns.busy('a.md')).toBe(false);
  });
});
