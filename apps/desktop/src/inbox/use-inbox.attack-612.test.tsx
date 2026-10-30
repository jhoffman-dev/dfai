// @vitest-environment jsdom
/**
 * Attack on PR #612 (#225): the Inbox says "Clarified" and offers Undo only
 * when something changed; a refusal is said on the row the note is on; two
 * clarifications asked for together keep their own undos. Fictional data only.
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
  type VaultFsPort,
} from '@dfai/application';
import {
  createVaultPath,
  INBOX_QUERY_COLUMNS,
  PARA_VALUES_QUERY_MARK,
  TASK_TYPE_FILE,
} from '@dfai/domain';
import { createToasts } from '../toasts/toasts.ts';
import { useInbox, type InboxOptions } from './use-inbox.ts';

const CALL = createVaultPath('Inbox/Call the florist.md');
const BOOK = createVaultPath('Inbox/Book the hall.md');
const FILED = 'Tasks/2026/10/Call the florist.md';
const TASK = (about: string) => `---\ntype: task\nstatus: inbox\n---\n\n${about}\n`;
const FILES = {
  'Projects/Larkspur.md': '---\ntype: project\n---\n',
  [CALL]: TASK('About the tulips.'),
  [BOOK]: TASK('About the hall.'),
};
const NO_PARA = { columns: ['path', 'para'], rows: [], truncated: false };

function inbox(fs: (base: VaultFsPort) => VaultFsPort = (base) => base) {
  const memory = memoryVault(FILES);
  const toasts = createToasts();
  const ports: ArchivePorts = {
    fs: fs(fakeVaultFs(memory.fs)),
    markdown: fakeMarkdown(),
    index: fakeIndexPort({
      query: async (sql) => {
        if (sql.startsWith(PARA_VALUES_QUERY_MARK)) return NO_PARA;
        // What the index lists: wherever each task waiting at Inbox is now.
        const rows = [...memory.files]
          .filter(([, text]) => text.includes('status: inbox'))
          .map(([at]) => [
            at,
            at.replace(/^.*\//, '').replace(/\.md$/, ''),
            'task',
            0,
            null,
            null,
            'inbox',
          ]);
        return { columns: [...INBOX_QUERY_COLUMNS], rows, truncated: false };
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
  const options: InboxOptions = {
    ports,
    notePaths: [...memory.files.keys()].map(createVaultPath),
    vaultKey: '/vaults/larkspur',
    types: [TASK_TYPE_FILE.type],
    clock: { today: () => '2026-10-11' },
    indexKey: 'ready:1',
    open: true,
    onSettled: vi.fn(),
    activity: recordingActivity(),
    closing: { beforeClose: async () => () => {} },
    toasts,
  };
  const hook = renderHook((given: InboxOptions) => useInbox(given), { initialProps: options });
  return { hook, files: memory.files, toasts };
}

describe('useInbox — "Clarified" only when something changed (#225, PR #612)', () => {
  it('offers no Undo for a clarification that left the note byte for byte as it was', async () => {
    const { hook, files, toasts } = inbox();
    // The row asks for what the note already says: the index had it stale, say.
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { status: 'inbox' } }),
    );

    expect(files.get(CALL)).toBe(TASK('About the tulips.'));
    expect(toasts.store.getState().toasts).toEqual([]);
    expect(hook.result.current.lastAction).toBeNull();
  });
});

describe('useInbox — a refusal said on the row the note is on (#225, PR #612)', () => {
  it('says why on the filed note’s row when it moved but its stamp could not be written', async () => {
    const { hook, files } = inbox((base) => ({
      ...base,
      writeTextFile: async (write) => {
        if (write.path.startsWith('Tasks/')) throw new Error('Permission denied.');
        return base.writeTextFile(write);
      },
    }));
    await act(() =>
      hook.result.current.clarify({
        path: CALL,
        clarification: { project: createVaultPath('Projects/Larkspur.md') },
      }),
    );
    // Moved: its row is now the one at its new path, still waiting at Inbox.
    expect(files.has(FILED)).toBe(true);

    expect(hook.result.current.refusals).toEqual([
      { path: FILED, reason: expect.stringMatching(/Permission denied/) },
    ]);
  });
});

describe('useInbox — two clarifications asked together (#225, PR #612)', () => {
  it('undoes only the second, leaving the first as it was written', async () => {
    const { hook, files } = inbox();
    await act(async () => {
      const first = hook.result.current.clarify({
        path: CALL,
        clarification: { status: 'next-action' },
      });
      const second = hook.result.current.clarify({
        path: BOOK,
        clarification: { status: 'someday' },
      });
      await Promise.all([first, second]);
    });
    const firstWritten = files.get(CALL);
    expect(firstWritten).toContain('status: next-action');

    await act(() => hook.result.current.undo());

    await waitFor(() => expect(files.get(BOOK)).toBe(TASK('About the hall.')));
    expect(files.get(CALL)).toBe(firstWritten);
  });
});

describe('useInbox — a reason cleared wherever the note was and is (#225, PR #612 review)', () => {
  const LARKSPUR = createVaultPath('Projects/Larkspur.md');

  it('clears the reason at the Inbox path once a retry files the note cleanly', async () => {
    const { hook, files } = inbox();
    // Refused: a project is nobody to wait on.
    await act(() =>
      hook.result.current.clarify({
        path: CALL,
        clarification: { status: 'waiting', waitingOn: LARKSPUR },
      }),
    );
    expect(hook.result.current.refusals).toEqual([{ path: CALL, reason: expect.any(String) }]);

    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { project: LARKSPUR } }),
    );

    expect(files.has(FILED)).toBe(true);
    expect(hook.result.current.refusals).toEqual([]);
  });

  it('clears the reason at the filed path once the filing is undone', async () => {
    const { hook, files } = inbox((base) => ({
      ...base,
      writeTextFile: async (write) => {
        if (write.path.startsWith('Tasks/')) throw new Error('Permission denied.');
        return base.writeTextFile(write);
      },
    }));
    await act(() =>
      hook.result.current.clarify({ path: CALL, clarification: { project: LARKSPUR } }),
    );
    expect(hook.result.current.refusals).toEqual([
      { path: FILED, reason: expect.stringMatching(/Permission denied/) },
    ]);

    await act(() => hook.result.current.undo());

    await waitFor(() => expect(files.get(CALL)).toBe(TASK('About the tulips.')));
    expect(files.has(FILED)).toBe(false);
    expect(hook.result.current.refusals).toEqual([]);
  });
});
