// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePickChat } from './use-pick-chat.ts';

/** Picks `path` and lets the open settle. */
async function pick(onPick: (path: string) => void, path: string): Promise<void> {
  await act(async () => {
    onPick(path);
    await Promise.resolve();
  });
}

describe('usePickChat', () => {
  it('opens the chat picked, and says nothing when it opens', async () => {
    const open = vi.fn(() => Promise.resolve());
    const refresh = vi.fn();
    const { result } = renderHook(() => usePickChat({ open, refresh }));
    await pick(result.current.onPick, 'Chats/Payroll cutover.md');
    expect(open).toHaveBeenCalledWith('Chats/Payroll cutover.md');
    expect(result.current.problem).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('says why a chat whose note is gone could not be opened, and reads the list again', async () => {
    const open = vi.fn(() => Promise.reject(new Error('not_found: Chats/Gone.md')));
    const refresh = vi.fn();
    const { result } = renderHook(() => usePickChat({ open, refresh }));
    await pick(result.current.onPick, 'Chats/Gone.md');
    expect(result.current.problem).toBe('That chat could not be opened: not_found: Chats/Gone.md');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('says a refusal that is not an Error as it came', async () => {
    const open = vi.fn(() => Promise.reject('the vault is closed'));
    const { result } = renderHook(() => usePickChat({ open, refresh: vi.fn() }));
    await pick(result.current.onPick, 'Chats/Gone.md');
    expect(result.current.problem).toBe('That chat could not be opened: the vault is closed');
  });

  it('forgets the last problem on the next pick, or when cleared', async () => {
    const open = vi
      .fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('gone'))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => usePickChat({ open, refresh: vi.fn() }));
    await pick(result.current.onPick, 'Chats/Gone.md');
    expect(result.current.problem).not.toBeNull();
    await pick(result.current.onPick, 'Chats/Kept.md');
    expect(result.current.problem).toBeNull();

    open.mockRejectedValueOnce(new Error('gone'));
    await pick(result.current.onPick, 'Chats/Gone.md');
    expect(result.current.problem).not.toBeNull();
    act(() => result.current.clear());
    expect(result.current.problem).toBeNull();
  });
});
