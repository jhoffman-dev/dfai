// @vitest-environment jsdom
/**
 * Attack on #293 (PR #329): the sidebar's counts and marks as cached reads,
 * read again on the index's news, and dropped with the vault.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { TYPE_COUNTS_QUERY_MARK, type ObjectType } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, type IndexPort } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { createReadInvalidator } from '../reads/read-invalidator.ts';
import { useSidebarCatalog } from './use-sidebar-catalog.ts';

const TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];
const NO_NOTES: readonly string[] = [];
const MARK_COLUMNS = ['path', 'key', 'value', 'title'];

const settle = async () => {
  for (let turn = 0; turn < 8; turn += 1) await act(async () => {});
};

/** An index whose type count fails while `failing`, and counts `tasks` otherwise. */
function flakyIndex() {
  const state = { failing: true, tasks: 3 };
  const query = vi.fn(async (sql: string) => {
    if (!sql.startsWith(TYPE_COUNTS_QUERY_MARK)) return { columns: [], rows: [], truncated: false };
    if (state.failing) throw new Error('database is locked');
    return { columns: ['type', 'count'], rows: [['task', state.tasks]], truncated: false };
  });
  const counts = () => query.mock.calls.filter(([sql]) => sql.startsWith(TYPE_COUNTS_QUERY_MARK));
  return { index: fakeIndexPort({ query }), state, counts };
}

function renderCatalog(props: { index: IndexPort; vaultKey: string }) {
  const { wrapper, client } = queryWrapper();
  const reads = createReadInvalidator({ client });
  const hook = renderHook(
    (current: { index: IndexPort; vaultKey: string }) =>
      useSidebarCatalog({
        fs: fakeVaultFs(),
        markdown: remarkMarkdown,
        types: TYPES,
        notePaths: NO_NOTES,
        indexReady: true,
        ...current,
      }),
    { wrapper, initialProps: props },
  );
  return { hook, reads };
}

describe('a type count the index could not answer (attack-329)', () => {
  it('is not read again until the index has news', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const flaky = flakyIndex();
    renderCatalog({ index: flaky.index, vaultKey: 'v' });
    await settle();
    await settle();
    expect(flaky.counts()).toHaveLength(1);
  });

  it('recovers on the next news with the true count', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const flaky = flakyIndex();
    const { hook, reads } = renderCatalog({ index: flaky.index, vaultKey: 'v' });
    await settle();

    flaky.state.failing = false;
    act(() => reads.indexMoved('v'));
    await waitFor(() => expect(hook.result.current.sidebarTypes[0]?.count).toBe(3));
  });

  it('is asked of the index once for one piece of news', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const flaky = flakyIndex();
    const { reads } = renderCatalog({ index: flaky.index, vaultKey: 'v' });
    await settle();
    const before = flaky.counts().length;

    flaky.state.failing = false;
    act(() => reads.indexMoved('v'));
    await settle();
    expect(flaky.counts().length - before).toBe(1);
  });
});

describe('the sidebar across a vault switch (attack-329)', () => {
  it("does not show vault A's starred notes in vault B when A's read lands late", async () => {
    let releaseA = () => {};
    const marksA = fakeIndexPort({
      query: (sql: string) =>
        sql.startsWith(TYPE_COUNTS_QUERY_MARK)
          ? Promise.resolve({ columns: ['type', 'count'], rows: [], truncated: false })
          : new Promise((resolve) => {
              releaseA = () =>
                resolve({
                  columns: MARK_COLUMNS,
                  rows: [['Secret plan.md', 'favorite', true, 'Secret plan']],
                  truncated: false,
                });
            }),
    });
    const marksB = fakeIndexPort({
      query: async () => ({ columns: MARK_COLUMNS, rows: [], truncated: false }),
    });
    const { hook, reads } = renderCatalog({ index: marksA, vaultKey: 'a' });
    await settle();

    hook.rerender({ index: marksB, vaultKey: 'b' });
    act(() => reads.forget('a'));
    await act(async () => releaseA());
    await settle();

    expect(hook.result.current.catalog.favorites).toEqual([]);
  });

  it("shows vault A's starred notes again, read afresh, on switching back", async () => {
    const starred = { rows: [['Secret plan.md', 'favorite', true, 'Secret plan']] };
    const marksA = fakeIndexPort({
      query: async (sql: string) =>
        sql.startsWith(TYPE_COUNTS_QUERY_MARK)
          ? { columns: ['type', 'count'], rows: [], truncated: false }
          : { columns: MARK_COLUMNS, rows: starred.rows, truncated: false },
    });
    const marksB = fakeIndexPort({
      query: async () => ({ columns: MARK_COLUMNS, rows: [], truncated: false }),
    });
    const { hook, reads } = renderCatalog({ index: marksA, vaultKey: 'a' });
    await waitFor(() => expect(hook.result.current.catalog.favorites).toHaveLength(1));

    hook.rerender({ index: marksB, vaultKey: 'b' });
    act(() => reads.forget('a'));
    await settle();
    // Unstarred in another editor while vault B was open.
    starred.rows = [];
    hook.rerender({ index: marksA, vaultKey: 'a' });
    act(() => reads.forget('b'));
    await settle();

    expect(hook.result.current.catalog.favorites).toEqual([]);
  });
});
