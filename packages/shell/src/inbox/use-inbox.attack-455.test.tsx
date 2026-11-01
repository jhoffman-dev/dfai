// @vitest-environment jsdom
/**
 * Attack on PR #455 (#320): an Inbox toast left up across a vault switch.
 * `undoClarification` checks `held.store.getState().said?.last === taken`
 * — the raw `said`, not `told` (filtered to the open vault) as the page's
 * undo was before — then runs with the hook's *current* `vaultKey` and
 * `ports`, i.e. the new vault's.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  fakeIndexPort,
  fakeMarkdown,
  fakeVaultFs,
  memoryVault,
  recordingActivity,
  type ArchivePorts,
} from '@dfai/application';
import {
  createVaultPath,
  INBOX_QUERY_COLUMNS,
  PARA_VALUES_QUERY_MARK,
  TASK_TYPE_FILE,
} from '@dfai/domain';
import { createToasts } from '../toasts/toasts.ts';
import { useInbox, type InboxOptions } from './use-inbox.ts';

const CALL = createVaultPath('Inbox/Call the bank.md');
const CAPTURED = '---\ntype: task\nstatus: inbox\n---\n\nAbout the loan.\n';
const NO_PARA = { columns: ['path', 'para'], rows: [], truncated: false };

function portsOver(files: Record<string, string>) {
  const memory = memoryVault(files);
  const ports: ArchivePorts = {
    fs: fakeVaultFs(memory.fs),
    markdown: fakeMarkdown(),
    index: fakeIndexPort({
      query: async (sql) =>
        sql.startsWith(PARA_VALUES_QUERY_MARK)
          ? NO_PARA
          : {
              columns: [...INBOX_QUERY_COLUMNS],
              rows: [[CALL, 'Call the bank', 'task', 0, null, null, 'inbox']],
              truncated: false,
            },
      notesOfType: async () => [],
    }),
    editors: {
      state: () => 'closed',
      flush: async () => {},
      follow: () => {},
      abandon: () => {},
      reload: () => {},
    },
  };
  return { memory, ports };
}

describe('useInbox toast across a vault switch (attack-455)', () => {
  it('an Undo pressed on the last vault’s toast writes nothing in the vault now open', async () => {
    const a = portsOver({ [CALL]: CAPTURED });
    const toasts = createToasts();
    const initial: InboxOptions = {
      ports: a.ports,
      notePaths: [CALL],
      vaultKey: '/vaults/a',
      types: [TASK_TYPE_FILE.type],
      clock: { today: () => '2026-10-11' },
      indexKey: 'ready:1',
      open: true,
      onSettled: vi.fn(),
      activity: recordingActivity(),
      closing: { beforeClose: async () => () => {} },
      toasts,
    };
    const hook = renderHook((options: InboxOptions) => useInbox(options), {
      initialProps: initial,
    });
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { status: 'backlog' } }),
    );
    const clarified = a.memory.files.get(CALL) ?? '';
    expect(clarified).not.toBe(CAPTURED);
    const toast = toasts.store.getState().toasts.at(-1);
    expect(toast?.onUndo).toBeTypeOf('function');

    // Vault B: a copy of the same vault (a second Mac's, say), so its note
    // reads exactly as vault A's write left it.
    const b = portsOver({ [CALL]: clarified });
    const inB = { ...initial, ports: b.ports, notePaths: [CALL], vaultKey: '/vaults/b' };
    hook.rerender({ ...inB, indexKey: 'working', indexReady: false });
    // Vault B's index has read it: the page is settled on vault B.
    hook.rerender({ ...inB, indexKey: 'ready:2', indexReady: true });
    await act(async () => {});
    expect(hook.result.current.lastAction).toBeNull();

    await act(async () => {
      toast?.onUndo?.();
      toasts.dismiss(toast?.id ?? -1);
    });
    await act(async () => {});

    expect(b.memory.files.get(CALL)).toBe(clarified);
  });
});
