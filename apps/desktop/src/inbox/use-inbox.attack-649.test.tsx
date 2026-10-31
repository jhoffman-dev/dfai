// @vitest-environment jsdom
/**
 * PR #649 attack: U's wait for its row to be listed again is said to end "as
 * another vault opens" (`useUntilListedAgain`). A vault opened while the
 * undo is still being written is not one it hears of: the wait begins after
 * the switch, and runs to its full limit.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  fakeIndexPort,
  fakeMarkdown,
  fakeVaultFs,
  memoryVault,
  recordingActivity,
  type ArchivePorts,
} from '@dfai/application';
import { createVaultPath, INBOX_QUERY_COLUMNS, TASK_TYPE_FILE, type VaultPath } from '@dfai/domain';
import { useInbox, type InboxOptions } from './use-inbox.ts';

const CALL = createVaultPath('Inbox/Call Mara Quill.md');
const PAY = createVaultPath('Inbox/Pay Tobias Fenn.md');
const CAPTURED = '---\ntype: task\nstatus: inbox\n---\n\nAbout Larkspur Payroll.\n';

function inbox() {
  const memory = memoryVault({ [CALL]: CAPTURED, [PAY]: CAPTURED });
  let listed = [CALL, PAY];
  let held: Promise<void> | null = null;
  const ports: ArchivePorts = {
    fs: fakeVaultFs({
      ...memory.fs,
      writeTextFile: async (write) => {
        if (held !== null) await held;
        return memory.fs.writeTextFile(write);
      },
    }),
    markdown: fakeMarkdown(),
    index: fakeIndexPort({
      query: async () => ({
        columns: [...INBOX_QUERY_COLUMNS],
        rows: listed.map((at) => [at, at, 'task', 0, null, null, 'inbox']),
        truncated: false,
      }),
    }),
    editors: {
      state: () => 'closed',
      flush: async () => {},
      follow: () => {},
      abandon: () => {},
      reload: () => {},
    },
  };
  const initial: InboxOptions = {
    ports,
    notePaths: [CALL, PAY],
    vaultKey: '/vaults/larkspur',
    types: [TASK_TYPE_FILE.type],
    clock: { today: () => '2026-10-14' },
    indexKey: 'ready:1',
    open: true,
    // The refresh the undo asks for never lands: only the vault switch can end the wait.
    onSettled: vi.fn(() => Promise.reject(new Error('the index is busy'))),
    activity: recordingActivity(),
    closing: { beforeClose: async () => () => {} },
  };
  const hook = renderHook((options: InboxOptions) => useInbox(options), { initialProps: initial });
  const shown = () => hook.result.current.contents?.items.map((item) => item.path) ?? null;
  return {
    hook,
    files: memory.files,
    shown,
    switchVault: (vaultKey: string) => hook.rerender({ ...initial, vaultKey }),
    refresh: (still: readonly VaultPath[], indexKey: string) => {
      listed = [...still];
      hook.rerender({ ...initial, indexKey });
    },
    hold: () => {
      let open: () => void = () => {};
      held = new Promise<void>((resolve) => (open = resolve));
      return () => {
        held = null;
        open();
      };
    },
  };
}

describe('useInbox — U and a vault opened while it is written (PR #649 attack)', () => {
  it('ends the wait for the row when another vault opened while the undo was being written', async () => {
    const { hook, shown, files, refresh, switchVault, hold } = inbox();
    await waitFor(() => expect(shown()).toEqual([CALL, PAY]));
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { status: 'next-action' } }),
    );
    refresh([PAY], 'ready:2');
    await waitFor(() => expect(shown()).toEqual([PAY]));

    const release = hold();
    const said: { back?: VaultPath | null } = {};
    act(() => {
      void hook.result.current.takeBackLast().then((path) => {
        said.back = path;
      });
    });
    // Another vault opens while the undo's write is still on its way.
    act(() => switchVault('/vaults/quill'));
    await act(async () => release());
    await waitFor(() => expect(files.get(CALL)).toBe(CAPTURED));
    // Nothing will list the row in this vault: U should settle now, not after LISTED_AGAIN_LIMIT_MS (5 s).
    await waitFor(() => expect(said.back).not.toBeUndefined(), { timeout: 1_000 });
    // And says no row: the one it took back is the other vault's.
    expect(said.back).toBeNull();
  });
});
