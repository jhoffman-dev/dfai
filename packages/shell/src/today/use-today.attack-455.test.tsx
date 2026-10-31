// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  createVaultPath,
  REVIEW_PROJECTS_QUERY_MARK,
  REVIEW_TASKS_QUERY_MARK,
  type ObjectType,
} from '@dfai/domain';
import {
  fakeIndexPort,
  fakeVaultFs,
  memoryVault,
  recordingActivity,
  type QueryResult,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { createToasts } from '../toasts/toasts.ts';
import { useToday, type TodayOptions } from './use-today.ts';

/**
 * Attack on PR #455 (#320): a Today toast left up across a vault switch.
 * Before the PR the page's undo was `undoable`, filtered to the open vault;
 * the toast's Undo calls `undoChange(change)` directly, which only checks
 * `held.store.getState().last === change` — never the vault.
 */
const NOW = Date.UTC(2026, 9, 13, 15);
const CLOCK = { today: () => '2026-10-13', now: () => NOW };
const PATH = createVaultPath('Tasks/Ship the page.md');
const ROW = { path: PATH, title: 'Ship the page' };
const TEXT = '---\ntype: task\nstatus: next-action\ndue: 2026-10-13\n---\n\n# Ship\n';
const TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];

function answer(sql: string): QueryResult {
  if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
    return {
      columns: ['path', 'title', 'modified', 'status', 'due', 'defer'],
      rows: [[PATH, 'Ship the page', NOW, 'next-action', '2026-10-13', null]],
      truncated: false,
    };
  }
  if (sql.startsWith(REVIEW_PROJECTS_QUERY_MARK)) {
    return { columns: ['path', 'title', 'status', 'moving'], rows: [], truncated: false };
  }
  return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
}

function portsOver(files: Record<string, string>) {
  const memory = memoryVault(files);
  return {
    memory,
    ports: {
      index: fakeIndexPort({ query: async (sql: string) => answer(sql) }),
      fs: fakeVaultFs(memory.fs),
      markdown: remarkMarkdown,
    },
  };
}

describe('useToday toast across a vault switch (attack-455)', () => {
  it('an Undo pressed on the last vault’s toast writes nothing, to either vault', async () => {
    const a = portsOver({ [PATH]: TEXT });
    const b = portsOver({ [PATH]: TEXT });
    // The window's one set of editors (app.tsx `useOpenEditors`): after the
    // switch, vault B has its own note at the same path open in a pane.
    const paneWrites: unknown[] = [];
    let vaultBPaneOpen = false;
    const editors = {
      setPropertiesIfOpen: async (args: unknown) => {
        if (!vaultBPaneOpen) return false;
        paneWrites.push(args);
        return true;
      },
    } as unknown as OpenEditors;
    const toasts = createToasts();
    const base: TodayOptions = {
      ports: a.ports,
      editors,
      activity: recordingActivity(),
      clock: CLOCK,
      types: TYPES,
      vaultKey: 'vault-a',
      indexKey: '1',
      open: true,
      onSettled: vi.fn(),
      toasts,
    };
    const hook = renderHook((options: TodayOptions) => useToday(options), {
      initialProps: base,
    });
    await waitFor(() => expect(hook.result.current.page.today).not.toBeNull());
    await act(async () => hook.result.current.page.onDone(ROW));
    const ticked = a.memory.files.get(PATH);
    expect(ticked).not.toBe(TEXT);
    const toast = toasts.store.getState().toasts.at(-1);
    expect(toast?.onUndo).toBeTypeOf('function');

    // Switch to vault B with the toast still up (nothing clears the store).
    vaultBPaneOpen = true;
    hook.rerender({ ...base, ports: b.ports, vaultKey: 'vault-b', indexKey: '2' });
    expect(hook.result.current.notice).toBeNull();

    await act(async () => {
      toast?.onUndo?.();
      toasts.dismiss(toast?.id ?? -1);
    });
    await act(async () => {});

    expect(paneWrites).toEqual([]);
    expect(b.memory.files.get(PATH)).toBe(TEXT);
    expect(a.memory.files.get(PATH)).toBe(ticked);
  });
});
