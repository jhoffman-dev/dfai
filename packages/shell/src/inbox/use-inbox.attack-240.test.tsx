// @vitest-environment jsdom
/**
 * Attacks on the Inbox's `movedOn` latch (#240): quick vault switches, each
 * made while the index is working, failed or ready, and an index that fails
 * and then recovers. The Inbox must never show the last vault's rows, and
 * must always settle on the open vault's once its index is read.
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
import {
  createVaultPath,
  INBOX_QUERY_COLUMNS,
  PARA_VALUES_QUERY_MARK,
  TASK_TYPE_FILE,
} from '@dfai/domain';
import { useInbox, type InboxOptions } from './use-inbox.ts';

const NO_PARA = { columns: ['path', 'para'], rows: [], truncated: false };

function listingIndex(titles: readonly string[]) {
  return fakeIndexPort({
    query: async (sql) => {
      if (sql.startsWith(PARA_VALUES_QUERY_MARK)) return NO_PARA;
      return {
        columns: [...INBOX_QUERY_COLUMNS],
        rows: titles.map((title) => [`Inbox/${title}.md`, title, 'task', 0, null, null, 'inbox']),
        truncated: false,
      };
    },
    notesOfType: async () => [],
  });
}

const A = '/vaults/Larkspur';
const B = '/vaults/Quill';

function inbox() {
  const memory = memoryVault({ 'Inbox/Call the bank.md': '---\ntype: task\nstatus: inbox\n---\n' });
  const base: ArchivePorts = {
    fs: fakeVaultFs(memory.fs),
    markdown: fakeMarkdown(),
    index: listingIndex(['Call the bank']),
    editors: {
      state: () => 'closed',
      flush: async () => {},
      follow: () => {},
      abandon: () => {},
      reload: () => {},
    },
  };
  const of = { [A]: listingIndex(['Call the bank']), [B]: listingIndex(['Order seeds']) };
  const initial: InboxOptions = {
    ports: base,
    notePaths: [...memory.files.keys()].map(createVaultPath),
    vaultKey: A,
    types: [TASK_TYPE_FILE.type],
    clock: { today: () => '2026-10-11' },
    indexKey: 'ready:1',
    indexReady: true,
    open: true,
    onSettled: vi.fn(),
    activity: recordingActivity(),
    closing: { beforeClose: async () => () => {} },
  };
  const hook = renderHook((options: InboxOptions) => useInbox(options), { initialProps: initial });
  /** The page as the app renders it: `vault`'s ports, and the index's key. */
  const show = async (vault: string, indexKey: string, ports = of[vault as keyof typeof of]) => {
    hook.rerender({
      ...initial,
      vaultKey: vault,
      ports: { ...base, index: ports ?? base.index },
      indexKey,
      indexReady: indexKey.startsWith('ready'),
    });
    await act(async () => {});
  };
  const listed = () => hook.result.current.contents?.items.map((item) => item.title) ?? null;
  return { hook, show, listed };
}

describe('useInbox — quick vault switches (#240 latch)', () => {
  it('settles on A again after A→B→A made before the index moved off A', async () => {
    const { show, listed } = inbox();
    await waitFor(() => expect(listed()).toEqual(['Call the bank']));
    await show(B, 'ready:1', listingIndex(['Call the bank']));
    await show(A, 'ready:1');
    expect(listed()).toBeNull();
    await show(A, 'working');
    await show(A, 'ready:3');
    await waitFor(() => expect(listed()).toEqual(['Call the bank']));
  });

  it('settles on A after A→B→A, the switch back made while B was working', async () => {
    const { show, listed } = inbox();
    await waitFor(() => expect(listed()).toEqual(['Call the bank']));
    await show(B, 'ready:1', listingIndex(['Call the bank']));
    await show(B, 'working');
    await show(A, 'working');
    expect(listed()).toBeNull();
    await show(A, 'ready:3');
    await waitFor(() => expect(listed()).toEqual(['Call the bank']));
  });

  it('shows B’s rows, never A’s, after a switch made while the index had failed', async () => {
    const { show, listed } = inbox();
    await waitFor(() => expect(listed()).toEqual(['Call the bank']));
    await show(A, 'failed');
    await show(B, 'failed', listingIndex(['Call the bank']));
    expect(listed()).toBeNull();
    await show(B, 'working');
    expect(listed()).toBeNull();
    await show(B, 'ready:2');
    await waitFor(() => expect(listed()).toEqual(['Order seeds']));
  });

  it('keeps B’s rows up while B’s index fails, and reads them again once it recovers', async () => {
    const { show, listed } = inbox();
    await waitFor(() => expect(listed()).toEqual(['Call the bank']));
    await show(B, 'ready:1', listingIndex(['Call the bank']));
    await show(B, 'working');
    await show(B, 'ready:2');
    await waitFor(() => expect(listed()).toEqual(['Order seeds']));
    await show(B, 'working');
    await show(B, 'failed');
    expect(listed()).toEqual(['Order seeds']);
    await show(B, 'working');
    await show(B, 'ready:4', listingIndex(['Order seeds', 'Mend the gate']));
    await waitFor(() => expect(listed()).toEqual(['Order seeds', 'Mend the gate']));
  });

  it('lets a row decided after A→B→A leave, and keeps it gone through the re-index that follows', async () => {
    const { hook, show, listed } = inbox();
    await waitFor(() => expect(listed()).toEqual(['Call the bank']));
    await show(B, 'ready:1', listingIndex(['Call the bank']));
    await show(A, 'working');
    await show(A, 'ready:3');
    await waitFor(() => expect(listed()).toEqual(['Call the bank']));

    await act(async () => {
      await hook.result.current.clarify({
        path: createVaultPath('Inbox/Call the bank.md'),
        clarification: { status: 'backlog' },
      });
    });
    expect(listed()).toEqual([]);
    await show(A, 'working');
    await show(A, 'ready:4', listingIndex([]));
    await act(async () => {});
    expect(listed()).toEqual([]);
  });
});
