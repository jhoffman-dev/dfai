// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { NoteChange } from '@dfai/domain';
import type { ReadScope } from '@dfai/application';
import { createIndexStatusStore } from '../index/index-status-store.ts';
import { queryWrapper } from './query-wrapper.tsx';
import { createReadInvalidator } from './read-invalidator.ts';
import { useScopedIndexNews } from './use-scoped-index-news.ts';

const edited = (path: string, type: string | null = null): NoteChange => ({
  kind: 'changed',
  path,
  type,
  digest: 'b',
  before: 'a',
});

const RECIPES: ReadScope = { notes: ['Notes/Recipes.md'] };
const ANY_NOTE: ReadScope = { anyNote: true };

/** A ready index of `/one`, its reads, and a listener on one reader's news, counting what it heard. */
function listenTo(scope: ReadScope, vault: string | null = '/one') {
  const status = createIndexStatusStore();
  status.setState({ vault: '/one', phase: 'ready', revision: 1 });
  const { client, wrapper } = queryWrapper();
  const reads = createReadInvalidator({ client });
  const heard = { count: 0, renders: 0 };
  const hook = renderHook(
    ({ open }: { open: string | null }) => {
      heard.renders += 1;
      return useScopedIndexNews({ status, vault: open, reader: 'recipes', scope });
    },
    { wrapper, initialProps: { open: vault } },
  );
  const stop = hook.result.current.subscribe(() => {
    heard.count += 1;
  });
  const sentinel = { count: 0 };
  const everything = renderHook(
    () => useScopedIndexNews({ status, vault: '/one', reader: 'everything', scope: ANY_NOTE }),
    { wrapper },
  );
  everything.result.current.subscribe(() => {
    sentinel.count += 1;
  });
  /** The index settles once more, having heard `changes` (null: a build, whose notes are not told). */
  const news = (changes: NoteChange[] | null) =>
    act(() => {
      if (changes !== null) reads.noteChanges('/one', changes);
      const { revision } = status.getState();
      status.setState({ revision: revision + 1 });
      reads.indexMoved('/one', changes !== null);
    });
  return { heard, sentinel, news, hook, client, stop };
}

describe('the index’s news as a controller hears it, without drawing (#326)', () => {
  it('tells its listener of news that touched its scope', async () => {
    const { heard, news } = listenTo(RECIPES);
    await news([edited('Notes/Recipes.md')]);
    await waitFor(() => expect(heard.count).toBe(1));
  });

  it('does not tell it of a note outside its scope', async () => {
    const { heard, news, sentinel } = listenTo(RECIPES);
    await news([edited('Notes/Other.md')]);
    // A reader of every note hears the same news in the same pass: once it has, this one would have.
    await waitFor(() => expect(sentinel.count).toBe(1));
    expect(heard.count).toBe(0);
  });

  it('tells it of news whose notes are not known: a build, a failure', async () => {
    const { heard, news } = listenTo(RECIPES);
    await news(null);
    await waitFor(() => expect(heard.count).toBe(1));
  });

  it('never draws the component that holds it', async () => {
    const { heard, news } = listenTo(RECIPES);
    await news([edited('Notes/Recipes.md')]);
    await waitFor(() => expect(heard.count).toBe(1));
    expect(heard.renders).toBe(1);
  });

  it('stops telling it once it has stopped listening, and lets its query go', async () => {
    const { heard, news, stop, client, sentinel } = listenTo(RECIPES);
    stop();
    await news(null);
    await waitFor(() => expect(sentinel.count).toBe(1));
    expect(heard.count).toBe(0);
    const held = client.getQueryCache().findAll({ queryKey: ['vault', '/one', 'scoped'] });
    expect(held.map((query) => query.queryKey.at(-1))).toEqual(['everything']);
  });

  it('hears nothing with no vault open', async () => {
    const { heard, news, sentinel } = listenTo(RECIPES, null);
    await news(null);
    await waitFor(() => expect(sentinel.count).toBe(1));
    expect(heard.count).toBe(0);
  });

  it('keeps one feed while its vault stays open, and a new one for another', () => {
    const { hook } = listenTo(RECIPES);
    const first = hook.result.current;
    hook.rerender({ open: '/one' });
    expect(hook.result.current).toBe(first);
    hook.rerender({ open: '/two' });
    expect(hook.result.current).not.toBe(first);
  });
});
