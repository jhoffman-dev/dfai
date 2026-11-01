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
import { useToday } from './use-today.ts';

/** #320: a change on Today is said in the window's toasts, and taken back from there. */
const NOW = Date.UTC(2026, 9, 13, 15);
const CLOCK = { today: () => '2026-10-13', now: () => NOW };
const PATH = createVaultPath('Tasks/Ship the page.md');
const ROW = { path: PATH, title: 'Ship the page' };
const OTHER = { path: createVaultPath('Tasks/Call Mara Quill.md'), title: 'Call Mara Quill' };
const TEXT = '---\ntype: task\nstatus: next-action # as typed\ndue: 2026-10-13\n---\n\n# Ship\n';
const TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

function answer(sql: string): QueryResult {
  if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
    return {
      columns: ['path', 'title', 'modified', 'status', 'due', 'defer'],
      rows: [
        [PATH, 'Ship the page', NOW, 'next-action', '2026-10-13', null],
        [OTHER.path, OTHER.title, NOW, 'next-action', '2026-10-13', null],
      ],
      truncated: false,
    };
  }
  if (sql.startsWith(REVIEW_PROJECTS_QUERY_MARK)) {
    return { columns: ['path', 'title', 'status', 'moving'], rows: [], truncated: false };
  }
  return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
}

function setUp() {
  const memory = memoryVault({ [PATH]: TEXT, [OTHER.path]: TEXT });
  const ports = {
    index: fakeIndexPort({ query: async (sql: string) => answer(sql) }),
    fs: fakeVaultFs(memory.fs),
    markdown: remarkMarkdown,
  };
  const toasts = createToasts();
  const hook = renderHook(() =>
    useToday({
      ports,
      editors: noPane,
      activity: recordingActivity(),
      clock: CLOCK,
      types: TYPES,
      vaultKey: 'vault-a',
      indexKey: '1',
      open: true,
      onSettled: vi.fn(),
      toasts,
    }),
  );
  const shown = () => toasts.store.getState().toasts;
  /** Presses a toast's Undo as the toast does: the undo, then the toast goes. */
  const pressUndo = async (toast = shown().at(-1)) => {
    await act(async () => {
      toast?.onUndo?.();
      toasts.dismiss(toast?.id ?? -1);
    });
  };
  const text = () => memory.files.get(PATH) ?? '';
  return { ...hook, toasts, shown, pressUndo, text, files: memory.files, fs: ports.fs };
}

describe('useToday and the toasts', () => {
  it('says a tick once it lands, in the page’s words, with an Undo', async () => {
    const page = setUp();
    await waitFor(() => expect(page.result.current.page.today).not.toBeNull());
    await act(async () => page.result.current.page.onDone(ROW));

    expect(page.shown()).toHaveLength(1);
    expect(page.shown()[0]).toMatchObject({ message: 'Finished “Ship the page”.', tone: 'change' });
    expect(page.shown()[0]?.onUndo).toBeTypeOf('function');
  });

  it('takes the tick back from the toast: the file is back to the byte, and the undo is spent', async () => {
    const page = setUp();
    await waitFor(() => expect(page.result.current.page.today).not.toBeNull());
    await act(async () => page.result.current.page.onDone(ROW));
    expect(page.text()).not.toBe(TEXT);

    await page.pressUndo();

    await waitFor(() => expect(page.text()).toBe(TEXT));
    expect(page.result.current.notice).toBeNull();
    expect(page.shown()).toEqual([]);
  });

  it('lets the undo go with its toast', async () => {
    const page = setUp();
    await waitFor(() => expect(page.result.current.page.today).not.toBeNull());
    await act(async () => page.result.current.page.onDefer({ ...ROW, days: 1 }));
    expect(page.result.current.notice).not.toBeNull();

    act(() => page.toasts.dismiss(page.shown()[0]?.id ?? -1));

    expect(page.result.current.notice).toBeNull();
  });

  it('keeps one toast for the page: a second change takes the first one’s place', async () => {
    const page = setUp();
    await waitFor(() => expect(page.result.current.page.today).not.toBeNull());
    await act(async () => page.result.current.page.onDefer({ ...ROW, days: 1 }));
    const first = page.shown()[0];
    const deferred = page.text();
    await act(async () => page.result.current.page.onDefer({ ...OTHER, days: 2 }));

    expect(page.shown().map((toast) => toast.message)).toEqual([
      'Deferred “Call Mara Quill” by 2 days.',
    ]);
    // The first toast's Undo, pressed late, undoes nothing: its change is no longer the last.
    await page.pressUndo(first);
    expect(page.text()).toBe(deferred);
    expect(page.result.current.notice?.title).toBe('Call Mara Quill');
  });

  it('offers an undo that could not be written again, in a toast of its own, to be tried again', async () => {
    const page = setUp();
    await waitFor(() => expect(page.result.current.page.today).not.toBeNull());
    await act(async () => page.result.current.page.onDone(ROW));
    const write = page.fs.writeTextFile;
    page.fs.writeTextFile = async () => {
      page.fs.writeTextFile = write;
      throw new Error('The disk is full.');
    };

    await page.pressUndo();
    await waitFor(() => expect(page.result.current.page.problem).toMatch(/disk is full/));
    expect(page.shown().map((toast) => toast.message)).toEqual(['Finished “Ship the page”.']);
    expect(page.result.current.notice).not.toBeNull();

    await page.pressUndo();
    await waitFor(() => expect(page.text()).toBe(TEXT));
  });

  it('refuses an undo over a later edit, and keeps the edit', async () => {
    const page = setUp();
    await waitFor(() => expect(page.result.current.page.today).not.toBeNull());
    await act(async () => page.result.current.page.onSetStatus({ ...ROW, status: 'someday' }));
    const edited = page.text().replace('status: someday', 'status: backlog');
    page.files.set(PATH, edited);

    await page.pressUndo();

    await waitFor(() => expect(page.result.current.page.problem).toMatch(/changed since/));
    expect(page.text()).toBe(edited);
  });
});
