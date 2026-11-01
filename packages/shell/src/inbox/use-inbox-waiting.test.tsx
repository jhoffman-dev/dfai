// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { fakeIndexPort, fakeVaultFs, type IndexPort } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { ObjectType } from '@dfai/domain';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { readAgain, vaultReadKey } from '../reads/query-client.ts';
import { useInboxWaiting } from './use-inbox-waiting.ts';

/** An index whose Inbox count is `total`; nothing else is asked of it here. */
function countingIndex(total: number) {
  const query = vi.fn<IndexPort['query']>(async () => ({
    columns: ['total'],
    rows: [[total]],
    truncated: false,
  }));
  return { index: fakeIndexPort({ query }), query };
}

const NO_TYPES: readonly ObjectType[] = [];

describe('useInboxWaiting', () => {
  it('is unknown until the index is ready, then what waits, read again only when told to', async () => {
    const { index, query } = countingIndex(4);
    const { client, wrapper } = queryWrapper();
    const fs = fakeVaultFs();
    const { result, rerender } = renderHook(
      ({ ready }) =>
        useInboxWaiting({
          index,
          fs,
          markdown: remarkMarkdown,
          vaultKey: '/vault',
          indexReady: ready,
          types: NO_TYPES,
        }),
      { initialProps: { ready: false }, wrapper },
    );
    expect(result.current).toBeNull();
    expect(query).not.toHaveBeenCalled();

    rerender({ ready: true });
    await waitFor(() => expect(result.current).toBe(4));
    rerender({ ready: true });
    expect(query).toHaveBeenCalledTimes(1);

    await readAgain(client, vaultReadKey('/vault', 'inbox-waiting'));
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
  });

  it('is unknown with no vault open', () => {
    const { index, query } = countingIndex(4);
    const { result } = renderHook(
      () =>
        useInboxWaiting({
          index,
          fs: fakeVaultFs(),
          markdown: remarkMarkdown,
          vaultKey: null,
          indexReady: true,
          types: NO_TYPES,
        }),
      queryWrapper(),
    );
    expect(result.current).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
