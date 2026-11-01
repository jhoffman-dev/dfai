// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  createVaultPath,
  INBOX_QUERY_COLUMNS,
  PARA_VALUES_QUERY_MARK,
  TASK_TYPE_FILE,
} from '@dfai/domain';
import {
  fakeIndexPort,
  fakeMarkdown,
  fakeVaultFs,
  memoryVault,
  recordingActivity,
  type ArchivePorts,
} from '@dfai/application';
import { createInboxWrites } from './inbox-writes.ts';
import { useInbox, type InboxOptions } from './use-inbox.ts';

/*
 * The Inbox's writes in flight are the window's per vault (tab-model.md,
 * PR B): two tabs on the Inbox — one switched back to, or one in each pane —
 * read the same rows leaving and the same serial queue.
 */

const CALL = createVaultPath('Inbox/Call the bank.md');
const QUOTE = createVaultPath('Inbox/Chase the quote.md');
const FILES = {
  'Projects/DFAI.md': '---\ntype: project\n---\n',
  [CALL]: '---\ntype: task\nstatus: inbox\n---\n\nAbout the loan.\n',
  [QUOTE]: '---\ntype: task\nstatus: inbox\n---\n\nSoon.\n',
};
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

/** A vault whose writes to `held` wait until `release`: a write in flight. It keeps the order writes began in. */
function vaultHoldingWrites(held: string) {
  const memory = memoryVault(FILES);
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const began: string[] = [];
  const fs = fakeVaultFs({
    ...memory.fs,
    writeTextFile: async (args) => {
      began.push(args.path);
      if (args.path === held) await gate;
      return memory.fs.writeTextFile(args);
    },
  });
  return { memory, fs, release, began };
}

function options(ports: ArchivePorts, overrides: Partial<InboxOptions> = {}): InboxOptions {
  return {
    ports,
    notePaths: Object.keys(FILES).map(createVaultPath),
    vaultKey: '/vaults/a',
    types: [TASK_TYPE_FILE.type],
    clock: { today: () => '2026-10-11' },
    indexKey: 'ready:1',
    open: true,
    onSettled: vi.fn(),
    activity: recordingActivity(),
    closing: { beforeClose: async () => () => {} },
    ...overrides,
  };
}

describe('useInbox on a window-held set of writes', () => {
  it('a second tab on the same hold sees a row decided in the first as gone while its write is held', async () => {
    const { fs, release } = vaultHoldingWrites(CALL);
    const ports: ArchivePorts = {
      fs,
      markdown: fakeMarkdown(),
      index: listingIndex(['Call the bank', 'Chase the quote']),
      editors: {
        state: () => 'closed',
        flush: async () => {},
        follow: () => {},
        abandon: () => {},
        reload: () => {},
      },
    };
    const held = createInboxWrites();
    const first = renderHook(() => useInbox(options(ports, { held })));
    const listed = (hook: typeof first) =>
      hook.result.current.contents?.items.map((item) => item.title) ?? null;
    await waitFor(() => expect(listed(first)).toEqual(['Call the bank', 'Chase the quote']));

    act(() => {
      void first.result.current.clarify({ path: CALL, clarification: { status: 'someday' } });
    });
    await waitFor(() => expect(listed(first)).toEqual(['Chase the quote']));

    // The tab switched back to, or the other pane's: mounted afresh on the same hold.
    const second = renderHook(() => useInbox(options(ports, { held })));
    await waitFor(() => expect(listed(second)).toEqual(['Chase the quote']));
    // And its own hold would offer the row again, which is the bug the window's hold is for.
    const alone = renderHook(() => useInbox(options(ports)));
    await waitFor(() => expect(listed(alone)).toEqual(['Call the bank', 'Chase the quote']));

    release();
    await waitFor(() =>
      expect(first.result.current.lastAction).toEqual({ title: 'Call the bank' }),
    );
    // The last action, and its undo, are the window's too.
    expect(second.result.current.lastAction).toEqual({ title: 'Call the bank' });
  });

  it('writes asked for from two tabs go one after another through the one queue', async () => {
    const { memory, fs, release, began } = vaultHoldingWrites(CALL);
    const ports: ArchivePorts = {
      fs,
      markdown: fakeMarkdown(),
      index: listingIndex(['Call the bank', 'Chase the quote']),
      editors: {
        state: () => 'closed',
        flush: async () => {},
        follow: () => {},
        abandon: () => {},
        reload: () => {},
      },
    };
    const held = createInboxWrites();
    const first = renderHook(() => useInbox(options(ports, { held })));
    const second = renderHook(() => useInbox(options(ports, { held })));
    await waitFor(() => expect(first.result.current.contents).not.toBeNull());
    await waitFor(() => expect(second.result.current.contents).not.toBeNull());

    act(() => {
      void first.result.current.clarify({ path: CALL, clarification: { status: 'someday' } });
    });
    act(() => {
      void second.result.current.clarify({ path: QUOTE, clarification: { status: 'backlog' } });
    });
    // The first write begins and is held; the second waits behind it in the one
    // queue, so it has not begun — not merely not landed.
    await waitFor(() => expect(began).toContain(CALL));
    expect(began).toEqual([CALL]);
    expect(memory.files.get(QUOTE)).toContain('status: inbox');

    release();
    await waitFor(() => expect(memory.files.get(QUOTE)).toContain('status: backlog'));
    expect(memory.files.get(CALL)).toContain('status: someday');
    expect(began).toEqual([CALL, QUOTE]);
  });
});
