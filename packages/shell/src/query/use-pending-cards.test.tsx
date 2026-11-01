// @vitest-environment jsdom
/**
 * #260, PR #274: the cards a board is moving are of one index and one view.
 * Another opened, none carries over; and one card's moves are written in turn.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { BoardRow } from '@dfai/domain';
import type { PropertyChanges } from '@dfai/application';
import { useBoardAsPending, usePendingCards, type BoardShape } from './use-pending-cards.ts';

const ROWS: readonly BoardRow[] = [
  { path: 'One.md', title: 'One', values: { path: 'One.md', status: 'doing' } },
];
const READ = { at: 1, indexKey: 'ready:1' };
const SHAPE: BoardShape = { columns: [], lanes: [] };
// A board drawn from other rows: a new shape, whatever its columns hold.
const regroup = (): BoardShape => ({ columns: [], lanes: [] });

function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

function board(written: string[], holds: Promise<void>[]) {
  return renderHook(
    ({ scope }: { scope: readonly unknown[] }) => {
      const { pending, move } = usePendingCards({
        rows: ROWS,
        read: READ,
        runsBegun: () => 1,
        indexKey: 'ready:1',
        scope,
        write: async ({ values }: { path: string; values: PropertyChanges }) => {
          const hold = holds.shift();
          if (hold !== undefined) await hold;
          written.push(JSON.stringify(values));
        },
        onChanged: () => {},
      });
      const shown = useBoardAsPending({ pending, read: SHAPE, regroup });
      return { move, shown };
    },
    { initialProps: { scope: ['index-a', 'Board.md'] as readonly unknown[] } },
  );
}

const moveTo = (status: string) => ({
  path: 'One.md',
  values: { status },
  shown: () => ({ status }),
});

describe('usePendingCards', () => {
  it('lets every card go when another index or view is open, so none is drawn in it', () => {
    const view = board([], [gate().opened]);
    act(() => {
      void view.result.current.move(moveTo('done'));
    });
    expect(view.result.current.shown).not.toBe(SHAPE);

    view.rerender({ scope: ['index-b', 'Board.md'] });
    expect(view.result.current.shown.columns).toBe(SHAPE.columns);
  });

  it('writes a card’s second move only once its first has landed, in the order they were made', async () => {
    const written: string[] = [];
    const first = gate();
    const view = board(written, [first.opened]);
    act(() => {
      void view.result.current.move(moveTo('done'));
    });
    act(() => {
      void view.result.current.move(moveTo('backlog'));
    });
    await act(async () => {});
    expect(written).toEqual([]);

    await act(async () => first.open());
    await act(async () => {});
    expect(written).toEqual(['{"status":"done"}', '{"status":"backlog"}']);
  });
});
