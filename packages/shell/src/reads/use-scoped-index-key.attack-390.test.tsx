// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { NoteChange } from '@dfai/domain';
import type { ReadScope } from '@dfai/application';
import { createIndexStatusStore } from '../index/index-status-store.ts';
import { queryWrapper } from './query-wrapper.tsx';
import { createReadInvalidator } from './read-invalidator.ts';
import { useScopedIndexKey } from './use-scoped-index-key.ts';

/**
 * Attack on PR #390 (#325): a pane's key must move for news of what it shows
 * now — after its scope changed, while it was hidden, and in a burst of syncs
 * heard before one news.
 */

const edited = (path: string, type: string | null = null): NoteChange => ({
  kind: 'changed',
  path,
  type,
  digest: 'b',
  before: 'a',
});

interface Props {
  scope: ReadScope;
  enabled: boolean;
}

/** One pane reader of a ready `/one`, whose scope and shown state the test sets. */
function oneReader(initial: Props) {
  const status = createIndexStatusStore();
  status.setState({ vault: '/one', phase: 'ready', revision: 1 });
  const { client, wrapper } = queryWrapper();
  const reads = createReadInvalidator({ client });
  const hook = renderHook(
    ({ scope, enabled }: Props) =>
      useScopedIndexKey({ status, vault: '/one', reader: ['note', 'Journal.md'], scope, enabled }),
    { wrapper, initialProps: initial },
  );
  /** Syncs each heard `batch`, then the index settles once (null: notes not known). */
  const news = (...batches: (NoteChange[] | null)[]) =>
    act(() => {
      for (const batch of batches) if (batch !== null) reads.noteChanges('/one', batch);
      status.setState({ revision: status.getState().revision + 1 });
      reads.indexMoved('/one', !batches.includes(null));
    });
  const settle = () => act(() => new Promise((turn) => setTimeout(turn, 0)));
  return { hook, news, settle };
}

const JOURNAL: ReadScope = { notes: ['Journal.md'], linkedNames: ['plans'], facets: ['graph'] };

describe('attack-390: a pane reader’s key follows the scope it has now', () => {
  it('moves for a note it began to link to after it was first drawn (same reader, new scope)', async () => {
    const { hook, news } = oneReader({ scope: JOURNAL, enabled: true });
    hook.rerender({ scope: { ...JOURNAL, linkedNames: ['plans', 'packing list'] }, enabled: true });

    await news([edited('Trips/Packing list.md')]);
    await waitFor(() => expect(hook.result.current).toBe('ready:2'));
  });

  it('holds for a note it no longer links to', async () => {
    const { hook, news, settle } = oneReader({ scope: JOURNAL, enabled: true });
    hook.rerender({ scope: { ...JOURNAL, linkedNames: [] }, enabled: true });

    await news([edited('Plans.md')]);
    await settle();
    expect(hook.result.current).toBe('ready:1');
  });
});

describe('attack-390: a hidden tab’s reader (enabled false)', () => {
  it('moves once shown for news of what it shows that came while it was hidden', async () => {
    const { hook, news, settle } = oneReader({ scope: JOURNAL, enabled: false });
    await news([edited('Plans.md')]);
    await settle();
    expect(hook.result.current).toBe('ready:1');

    hook.rerender({ scope: JOURNAL, enabled: true });
    await waitFor(() => expect(hook.result.current).toBe('ready:2'));
  });

  it('moves once shown for news whose notes were not known (a rebuild while hidden)', async () => {
    const { hook, news } = oneReader({ scope: JOURNAL, enabled: false });
    await news(null);

    hook.rerender({ scope: JOURNAL, enabled: true });
    await waitFor(() => expect(hook.result.current).toBe('ready:2'));
  });

  it('moves once shown for news while hidden followed by unrelated news', async () => {
    const { hook, news } = oneReader({ scope: JOURNAL, enabled: false });
    await news([edited('Plans.md')]);
    await news([edited('Elsewhere.md')]);

    hook.rerender({ scope: JOURNAL, enabled: true });
    await waitFor(() => expect(hook.result.current).toBe('ready:3'));
  });
});

describe('attack-390: a burst of syncs heard before one news', () => {
  it('judges every sync’s notes, not only the last one’s', async () => {
    const { hook, news } = oneReader({ scope: JOURNAL, enabled: true });
    await news([edited('Plans.md')], [edited('Elsewhere.md')], [edited('Other.md')]);
    await waitFor(() => expect(hook.result.current).toBe('ready:2'));
  });

  it('forgets what it heard once judged: the next news is judged alone', async () => {
    const { hook, news, settle } = oneReader({ scope: JOURNAL, enabled: true });
    await news([edited('Plans.md')]);
    await waitFor(() => expect(hook.result.current).toBe('ready:2'));

    await news([edited('Elsewhere.md')]);
    await settle();
    expect(hook.result.current).toBe('ready:2');
  });
});
