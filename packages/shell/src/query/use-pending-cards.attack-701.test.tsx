// @vitest-environment jsdom
/**
 * Attack on PR #701 (#698): a card moved on a board settles on a run of the
 * view stamped with the index's own key past where it stood as the move's
 * refresh was asked. These probe what "past" means — any other key counts,
 * including one that says the refresh failed and the index never took the
 * move in — and a card's second move while its first is read back.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { BoardRow } from '@dfai/domain';
import type { ReadMoment } from '@dfai/application';
import { usePendingCards } from './use-pending-cards.ts';

const rowsAt = (status: string): readonly BoardRow[] => [
  { path: 'One.md', title: 'One', values: { path: 'One.md', status } },
];

function board({
  withKeyNow = true,
  write = async () => {},
}: { withKeyNow?: boolean; write?: () => Promise<void> } = {}) {
  /** The index's own key, ahead of the news the view runs on, and the runs begun. */
  const index = { key: 'ready:1', runs: 1 };
  const hook = renderHook(
    ({ rows, read }: { rows: readonly BoardRow[]; read: ReadMoment }) =>
      usePendingCards({
        rows,
        read,
        runsBegun: () => index.runs,
        // Without the index's own key, the news a run began on stands for it.
        indexKeyNow: withKeyNow ? () => index.key : () => read.indexKey,
        scope: ['index-a', 'Board.md'],
        write,
        onChanged: () => {},
      }),
    { initialProps: { rows: rowsAt('doing'), read: { at: 1, indexKey: 'ready:1' } } },
  );
  /** A run of the view begins, at the index's key now, and reads `status`. */
  const run = (status: string) => {
    index.runs += 1;
    hook.rerender({ rows: rowsAt(status), read: { at: index.runs, indexKey: index.key } });
  };
  const move = (status: string) =>
    hook.result.current.move({ path: 'One.md', values: { status }, shown: () => ({ status }) });
  const shown = () => hook.result.current.shownOf('One.md')?.['status'];
  return { index, run, move, shown };
}

describe('usePendingCards — attack #701', () => {
  // FOUND, and fixed: the move's refresh failed, so the index still held the card where it
  // was, and `failed:2` differing from `ready:1` read as standing for the move. A run of an
  // index that is not ready now stands for no move: the card stays where it was put until
  // the index is ready past it.
  it('keeps a moved card where it was put through a run of an index whose refresh failed, until the index is ready', async () => {
    const { index, run, move, shown } = board();
    await act(async () => move('done'));
    expect(shown()).toBe('done');
    index.key = 'failed:2';
    run('doing');
    expect(shown()).toBe('done');
    // Still failed on the next run: still drawn where it was put, not snapped back.
    index.key = 'failed:3';
    run('doing');
    expect(shown()).toBe('done');
    // Ready again, past the move: the index's read stands, whatever it says.
    index.key = 'ready:4';
    run('doing');
    expect(shown()).toBe('doing');
  });

  it('probe: a second move of a card holds through a run that read back only the first', async () => {
    let writes = 0;
    let releaseSecond = () => {};
    const secondHeld = new Promise<void>((resolve) => (releaseSecond = resolve));
    const { index, run, move, shown } = board({
      write: async () => {
        writes += 1;
        if (writes === 2) await secondHeld;
      },
    });
    let second: Promise<void> = Promise.resolve();
    await act(async () => {
      const first = move('done');
      second = move('waiting');
      await first;
    });
    // The first move's refresh ran: the index has it, not the second.
    index.key = 'ready:2';
    run('done');
    expect(shown()).toBe('waiting');
    await act(async () => {
      releaseSecond();
      await second;
    });
    // A run still at the key the second landed at is behind it.
    run('done');
    expect(shown()).toBe('waiting');
    index.key = 'ready:3';
    run('waiting');
    expect(shown()).toBe('waiting');
  });

  it('probe: with no indexKeyNow, a run at the same news key does not settle the card', async () => {
    const { run, move, shown } = board({ withKeyNow: false });
    await act(async () => move('done'));
    run('doing');
    expect(shown()).toBe('done');
  });
});
