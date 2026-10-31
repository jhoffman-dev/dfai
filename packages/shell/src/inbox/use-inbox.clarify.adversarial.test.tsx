// @vitest-environment jsdom
/**
 * Adversarial pass on #112: the Inbox hook when the write under a decision
 * fails, and when two decisions are asked for at once (#217).
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
import { createVaultPath, INBOX_QUERY_COLUMNS, TASK_TYPE_FILE } from '@dfai/domain';
import { useInbox, type InboxOptions } from './use-inbox.ts';

const CALL = createVaultPath('Inbox/Call Tobias Fenn.md');
const WRITE = createVaultPath('Inbox/Write to Mara Quill.md');
const CAPTURED = '---\ntype: task\nstatus: inbox\n---\n\nAbout the lease.\n';

function inbox(failing: { write?: string } = {}) {
  const memory = memoryVault({ [CALL]: CAPTURED, [WRITE]: CAPTURED });
  let refuseWrites = false;
  const ports: ArchivePorts = {
    fs: fakeVaultFs({
      ...memory.fs,
      writeTextFile: async (write) => {
        if (refuseWrites) throw new Error(failing.write ?? 'permission denied');
        return memory.fs.writeTextFile(write);
      },
    }),
    markdown: fakeMarkdown(),
    index: fakeIndexPort({
      query: async () => ({
        columns: [...INBOX_QUERY_COLUMNS],
        rows: [CALL, WRITE].map((at) => [at, at, 'task', 0, null, null, 'inbox']),
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
  const onSettled = vi.fn();
  const options: InboxOptions = {
    ports,
    notePaths: [...memory.files.keys()].map(createVaultPath),
    vaultKey: '/vaults/larkspur',
    types: [TASK_TYPE_FILE.type],
    clock: { today: () => '2026-10-12' },
    indexKey: 'ready:1',
    open: true,
    onSettled,
    activity: recordingActivity(),
    closing: { beforeClose: async () => () => {} },
  };
  const hook = renderHook((given: InboxOptions) => useInbox(given), { initialProps: options });
  return {
    hook,
    files: memory.files,
    onSettled,
    refuseWrites: () => {
      refuseWrites = true;
    },
  };
}

describe('useInbox — the write under a decision fails', () => {
  it('says why on the row, keeps the row and the undo before it, and is ready for the next', async () => {
    const { hook, files, onSettled, refuseWrites } = inbox();
    await act(() =>
      hook.result.current.clarify({ path: WRITE, clarification: { due: '2026-10-20' } }),
    );
    refuseWrites();

    let done = true;
    await act(async () => {
      done = await hook.result.current.clarify({
        path: CALL,
        clarification: { status: 'next-action' },
      });
    });

    expect(done).toBe(false);
    expect(hook.result.current.refusals).toEqual([{ path: CALL, reason: 'permission denied' }]);
    expect(files.get(CALL)).toBe(CAPTURED);
    expect(hook.result.current.contents?.items.map((item) => item.path)).toContain(CALL);
    expect(hook.result.current.busy).toBe(false);
    expect(hook.result.current.lastAction).toEqual({ title: 'Write to Mara Quill' });
    expect(onSettled).toHaveBeenCalledOnce();
  });
});

describe('useInbox — two decisions asked for in one tick', () => {
  // #217 replaced "the second is not made, and says so": the next row is worked
  // while the last is still being written, so both are written, in turn.
  it('writes both, one after the other, and re-reads once for the two', async () => {
    const { hook, files, onSettled } = inbox();

    let outcomes: boolean[] = [];
    await act(async () => {
      outcomes = await Promise.all([
        hook.result.current.clarify({ path: CALL, clarification: { status: 'next-action' } }),
        hook.result.current.clarify({ path: WRITE, clarification: { status: 'someday' } }),
      ]);
    });

    expect(outcomes).toEqual([true, true]);
    expect(files.get(CALL)).toContain('status: next-action');
    expect(files.get(WRITE)).toContain('status: someday');
    expect(hook.result.current.refusals).toEqual([]);
    expect(onSettled).toHaveBeenCalledOnce();
  });
});
