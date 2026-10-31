// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { NoteChange } from '@dfai/domain';
import type { ReadScope } from '@dfai/application';
import { createIndexStatusStore } from '../index/index-status-store.ts';
import { queryWrapper } from './query-wrapper.tsx';
import { createReadInvalidator } from './read-invalidator.ts';
import { useScopedIndexKey } from './use-scoped-index-key.ts';

const edited = (path: string, type: string | null = null): NoteChange => ({
  kind: 'changed',
  path,
  type,
  digest: 'b',
  before: 'a',
});

/** A ready index of `/one`, its reads, and a key for each scope, as the panes hold them. */
function keysFor(scopes: Record<string, ReadScope>) {
  const status = createIndexStatusStore();
  status.setState({ vault: '/one', phase: 'ready', revision: 1 });
  const { client, wrapper } = queryWrapper();
  const reads = createReadInvalidator({ client });
  const hook = renderHook(
    () =>
      Object.fromEntries(
        Object.entries(scopes).map(([name, scope]) => [
          name,
          useScopedIndexKey({ status, vault: '/one', reader: [name], scope }),
        ]),
      ),
    { wrapper },
  );
  /** The index settles once more, having heard `changes` (null: a build, whose notes are not told). */
  const news = (changes: NoteChange[] | null) =>
    act(() => {
      if (changes !== null) reads.noteChanges('/one', changes);
      const { revision } = status.getState();
      status.setState({ revision: revision + 1 });
      reads.indexMoved('/one', changes !== null);
    });
  return { hook, news, status };
}

describe('the index’s key as a pane’s reader sees it (#325)', () => {
  const scopes = { recipes: { notes: ['Notes/Recipes.md'] }, today: { types: ['task'] } };

  it('starts at the index’s key, with nothing read', () => {
    const { hook } = keysFor(scopes);
    expect(hook.result.current).toEqual({ recipes: 'ready:1', today: 'ready:1' });
  });

  it('moves for news that touched what its reader is made from, and holds for any other', async () => {
    const { hook, news } = keysFor(scopes);

    await news([edited('Tasks/Buy flour.md', 'task')]);
    await waitFor(() => expect(hook.result.current.today).toBe('ready:2'));
    expect(hook.result.current.recipes).toBe('ready:1');

    await news([edited('Notes/Recipes.md')]);
    await waitFor(() => expect(hook.result.current.recipes).toBe('ready:3'));
    expect(hook.result.current.today).toBe('ready:2');
  });

  it('moves for every reader on news whose notes are not known', async () => {
    const { hook, news } = keysFor(scopes);

    await news(null);

    await waitFor(() =>
      expect(hook.result.current).toEqual({ recipes: 'ready:2', today: 'ready:2' }),
    );
  });

  it('does not draw its reader for news it is not made from', async () => {
    let drawn = 0;
    const status = createIndexStatusStore();
    status.setState({ vault: '/one', phase: 'ready', revision: 1 });
    const { client, wrapper } = queryWrapper();
    const reads = createReadInvalidator({ client });
    renderHook(
      () => {
        drawn += 1;
        return useScopedIndexKey({
          status,
          vault: '/one',
          reader: ['r'],
          scope: { notes: ['a.md'] },
        });
      },
      { wrapper },
    );
    const before = drawn;

    act(() => {
      reads.noteChanges('/one', [edited('b.md')]);
      status.setState({ revision: 2 });
      reads.indexMoved('/one');
    });
    await act(() => new Promise((turn) => setTimeout(turn, 0)));

    expect(drawn).toBe(before);
  });
});

describe('the key of a reader whose last read failed (#424)', () => {
  it('moves on the index’s next news, touched or not, and holds again once the reader has read', async () => {
    const status = createIndexStatusStore();
    status.setState({ vault: '/one', phase: 'ready', revision: 1 });
    const { client, wrapper } = queryWrapper();
    const reads = createReadInvalidator({ client });
    const hook = renderHook(
      ({ failed }: { failed: boolean }) =>
        useScopedIndexKey({
          status,
          vault: '/one',
          reader: ['archive'],
          scope: { notes: ['a.md'] },
          failed,
        }),
      { wrapper, initialProps: { failed: true } },
    );
    const elsewhere = (revision: number) =>
      act(() => {
        reads.noteChanges('/one', [edited('b.md')]);
        status.setState({ revision });
        reads.indexMoved('/one');
      });

    await elsewhere(2);
    await waitFor(() => expect(hook.result.current).toBe('ready:2'));

    hook.rerender({ failed: false });
    await elsewhere(3);
    await act(() => new Promise((turn) => setTimeout(turn, 0)));
    expect(hook.result.current).toBe('ready:2');
  });
});
