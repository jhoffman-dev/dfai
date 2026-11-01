// @vitest-environment jsdom
/**
 * #698, on a board: a card moved settles only on a run of the view begun once
 * the index has moved past where it stood as the move's refresh was asked.
 * The news of an index that moved just before the write landed reaches the
 * view later, and a run begun on it is of the vault from before the move.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { BoardRow } from '@dfai/domain';
import type { ReadMoment } from '@dfai/application';
import { usePendingCards } from './use-pending-cards.ts';

const rowsAt = (status: string): readonly BoardRow[] => [
  { path: 'One.md', title: 'One', values: { path: 'One.md', status } },
];

function board() {
  /** The index's own key, ahead of the news the view runs on. */
  const index = { key: 'ready:1', runs: 1 };
  // A write the test holds mid-way.
  let held: Promise<void> | null = null;
  const hook = renderHook(
    ({ rows, read }: { rows: readonly BoardRow[]; read: ReadMoment }) =>
      usePendingCards({
        rows,
        read,
        runsBegun: () => index.runs,
        indexKeyNow: () => index.key,
        scope: ['index-a', 'Board.md'],
        write: async () => {
          if (held !== null) await held;
        },
        onChanged: () => {},
      }),
    { initialProps: { rows: rowsAt('doing'), read: { at: 1, indexKey: 'ready:1' } } },
  );
  /** A run of the view begins, at the index's key now, and reads `status`. */
  const run = (status: string) => {
    index.runs += 1;
    hook.rerender({ rows: rowsAt(status), read: { at: index.runs, indexKey: index.key } });
  };
  /** Holds the next writes until the function it returns is called. */
  const holdWrites = () => {
    let release = () => {};
    held = new Promise<void>((resolve) => (release = resolve));
    return () => {
      held = null;
      release();
    };
  };
  return { hook, index, run, holdWrites };
}

describe('usePendingCards — settling on news that comes late (#698)', () => {
  it('keeps a moved card where it was put through a run of an index that moved before the move landed', async () => {
    const { hook, index, run, holdWrites } = board();
    // The move is being written when another note's refresh, which read the vault before
    // it, moves the index.
    const release = holdWrites();
    let moved: Promise<void> = Promise.resolve();
    act(() => {
      moved = hook.result.current.move({
        path: 'One.md',
        values: { status: 'done' },
        shown: () => ({ status: 'done' }),
      });
    });
    index.key = 'ready:2';
    await act(async () => {
      release();
      await moved;
    });
    expect(hook.result.current.shownOf('One.md')?.['status']).toBe('done');

    // Its news arrives after the move landed: the run is of the index from before it.
    run('doing');
    expect(hook.result.current.shownOf('One.md')?.['status']).toBe('done');

    // The move's own refresh runs: the index has it, moves, and the card is read back.
    index.key = 'ready:3';
    run('done');
    expect(hook.result.current.shownOf('One.md')?.['status']).toBe('done');
  });

  it('control: a run of an index that moved after the move landed reads the card back', async () => {
    const { hook, index, run } = board();
    await act(async () => {
      await hook.result.current.move({
        path: 'One.md',
        values: { status: 'done' },
        shown: () => ({ status: 'done' }),
      });
    });
    index.key = 'ready:2';
    // Read back as the index has it: a card the index still lists as doing is drawn as doing.
    run('doing');
    expect(hook.result.current.shownOf('One.md')?.['status']).toBe('doing');
  });
});
