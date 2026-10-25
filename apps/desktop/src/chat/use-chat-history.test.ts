// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { VaultFsPort } from '@dfai/application';
import { useChatHistory } from './use-chat-history.ts';

/** A vault whose `Chats/` holds `names`, or whose listing fails with `failure`. */
function vaultOf({ names = [] as string[], failure = null as string | null } = {}) {
  let chats = names;
  const listDirectory = vi.fn(async (path: string) => {
    if (failure !== null) throw new Error(failure);
    if (path === '') return [{ kind: 'directory', path: 'Chats', name: 'Chats' }];
    return chats.map((name) => ({ kind: 'file', path: `Chats/${name}.md`, name: `${name}.md` }));
  });
  // Past chats reads only the listing; the rest of the port is never reached.
  const fs = { listDirectory } as unknown as VaultFsPort;
  return {
    fs,
    listDirectory,
    remove: (name: string) => (chats = chats.filter((chat) => chat !== name)),
  };
}

function history({
  fs,
  open = vi.fn(() => Promise.resolve()),
}: {
  fs: VaultFsPort;
  open?: (path: string) => Promise<void>;
}) {
  return renderHook(() => useChatHistory({ session: { open }, fs, chatPath: null }));
}

describe('useChatHistory', () => {
  it('lists the chats in Chats/ once opened', async () => {
    const { fs } = vaultOf({ names: ['Payroll cutover'] });
    const { result } = history({ fs });
    act(() => result.current.onOpenChange(true));
    await waitFor(() =>
      expect(result.current.chats.map((chat) => chat.title)).toEqual(['Payroll cutover']),
    );
    expect(result.current.problem).toBeNull();
  });

  it('says why the list could not be read, rather than listing none', async () => {
    const { fs } = vaultOf({ failure: 'Operation not permitted (os error 1)' });
    const { result } = history({ fs });
    act(() => result.current.onOpenChange(true));
    await waitFor(() =>
      expect(result.current.problem).toBe(
        'Past chats could not be read: Operation not permitted (os error 1)',
      ),
    );
    expect(result.current.chats).toEqual([]);
  });

  it('opens the list again on a pick that fails, read afresh so the gone row goes', async () => {
    const vault = vaultOf({ names: ['Payroll cutover', 'Quill rollout'] });
    const open = vi.fn(() => {
      vault.remove('Payroll cutover');
      return Promise.reject(new Error('not_found: Chats/Payroll cutover.md'));
    });
    const { result } = history({ fs: vault.fs, open });
    act(() => result.current.onOpenChange(true));
    await waitFor(() => expect(result.current.chats).toHaveLength(2));

    act(() => result.current.onPick('Chats/Payroll cutover.md'));
    expect(result.current.open).toBe(false);
    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.problem).toBe(
      'That chat could not be opened: not_found: Chats/Payroll cutover.md',
    );
    await waitFor(() =>
      expect(result.current.chats.map((chat) => chat.title)).toEqual(['Quill rollout']),
    );
  });

  it('forgets why a pick failed once the list is closed', async () => {
    const { fs } = vaultOf({ names: ['Payroll cutover'] });
    const open = vi.fn(() => Promise.reject(new Error('gone')));
    const { result } = history({ fs, open });
    act(() => result.current.onPick('Chats/Payroll cutover.md'));
    await waitFor(() => expect(result.current.problem).not.toBeNull());
    act(() => result.current.onOpenChange(false));
    expect(result.current.problem).toBeNull();
  });
});
