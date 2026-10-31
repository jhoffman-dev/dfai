// @vitest-environment jsdom
/**
 * Adversarial pass on #260 (PR #274): a tick on Today is drawn at once, as
 * `todayAsPending` works the change out. A repeating task ticked is rolled on
 * by the use-case — back to Next Action, due next time — so it stays on the
 * page, and the pending draw must put it where the roll does, not take it off.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  createVaultPath,
  REVIEW_PROJECTS_QUERY_MARK,
  REVIEW_TASKS_QUERY_MARK,
  type ObjectType,
  type TodaySectionId,
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
import { useToday, type TodayOptions } from './use-today.ts';

const NOW = Date.UTC(2026, 9, 13, 15);
const CLOCK = { today: () => '2026-10-13', now: () => NOW };
const WATER = createVaultPath('Tasks/Water the plants.md');
const CALL = createVaultPath('Tasks/Call the bank.md');
const TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

const field = (text: string, key: string) =>
  new RegExp(`^${key}: (.*)$`, 'm').exec(text)?.[1] ?? null;

function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

function today(files: Record<string, string>) {
  const memory = memoryVault(files);
  const indexedNow = () =>
    Object.keys(files).map((at) => {
      const text = memory.files.get(createVaultPath(at)) ?? '';
      return [at, at.slice(6, -3), NOW, field(text, 'status'), field(text, 'due'), null];
    });
  let indexed = indexedNow();
  let held: Promise<void> | null = null;
  const answer = (sql: string): QueryResult => {
    if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
      return {
        columns: ['path', 'title', 'modified', 'status', 'due', 'defer'],
        rows: indexed,
        truncated: false,
      };
    }
    if (sql.startsWith(REVIEW_PROJECTS_QUERY_MARK)) {
      return { columns: ['path', 'title', 'status', 'moving'], rows: [], truncated: false };
    }
    return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
  };
  const ports = {
    index: fakeIndexPort({ query: async (sql: string) => answer(sql) }),
    fs: fakeVaultFs({
      ...memory.fs,
      writeTextFile: async (write) => {
        if (held !== null) await held;
        return memory.fs.writeTextFile(write);
      },
    }),
    markdown: remarkMarkdown,
  };
  const initial: TodayOptions = {
    ports,
    editors: noPane,
    activity: recordingActivity(),
    clock: CLOCK,
    types: TYPES,
    vaultKey: 'vault-a',
    indexKey: 'ready:1',
    open: true,
    onSettled: () => {},
  };
  const hook = renderHook((options: TodayOptions) => useToday(options), {
    initialProps: initial,
  });
  const titlesIn = (id: TodaySectionId) =>
    hook.result.current.page.today?.sections
      .find((section) => section.id === id)
      ?.groups.flatMap((group) => group.tasks.map((task) => task.title)) ?? null;
  return {
    hook,
    files: memory.files,
    titlesIn,
    refresh: (indexKey: string) => {
      indexed = indexedNow();
      hook.rerender({ ...initial, indexKey });
    },
    hold: () => {
      const writes = gate();
      held = writes.opened;
      return () => {
        held = null;
        writes.open();
      };
    },
  };
}

const REPEATING = {
  [WATER]:
    '---\ntype: task\nstatus: in-progress\ndue: 2026-10-10\nrecurrence: daily\n---\n\nDaily.\n',
  [CALL]: '---\ntype: task\nstatus: next-action\n---\n\nOnce.\n',
};

describe('useToday — a repeating task ticked is drawn where its roll puts it (#260, PR #274)', () => {
  it('the use-case rolls a daily task due 10-10 to Next Action due 10-11, which is still Overdue', async () => {
    const page = today(REPEATING);
    await waitFor(() => expect(page.titlesIn('overdue')).toEqual(['Water the plants']));

    await act(async () =>
      page.hook.result.current.page.onDone({ path: WATER, title: 'Water the plants' }),
    );
    await waitFor(() => expect(page.files.get(WATER)).toContain('due: 2026-10-11'));
    expect(page.files.get(WATER)).toContain('status: next-action');
    page.refresh('ready:2');

    // What the page shows once the index has the write: the task, still overdue.
    await waitFor(() => expect(page.titlesIn('overdue')).toEqual(['Water the plants']));
  });

  it('keeps a ticked repeating task on the page, in Overdue, while its write is held', async () => {
    const page = today(REPEATING);
    await waitFor(() => expect(page.titlesIn('overdue')).toEqual(['Water the plants']));
    const release = page.hold();

    act(() => page.hook.result.current.page.onDone({ path: WATER, title: 'Water the plants' }));

    // Expected: drawn where the roll puts it. Received on fb990142: [] — taken
    // off the page as if archived, then put back when the index reads the roll.
    expect(page.titlesIn('overdue')).toEqual(['Water the plants']);
    release();
    await waitFor(() => expect(page.files.get(WATER)).toContain('due: 2026-10-11'));
  });

  it('never draws a ticked repeating task off the page across the write and its read-back', async () => {
    const page = today(REPEATING);
    await waitFor(() => expect(page.titlesIn('overdue')).toEqual(['Water the plants']));
    const shownEachRender: boolean[] = [];
    const onPage = () =>
      page.hook.result.current.page.today?.sections.some((section) =>
        section.groups.some((group) => group.tasks.some((task) => task.path === WATER)),
      ) ?? false;

    const release = page.hold();
    act(() => page.hook.result.current.page.onDone({ path: WATER, title: 'Water the plants' }));
    shownEachRender.push(onPage());
    release();
    await waitFor(() => expect(page.files.get(WATER)).toContain('due: 2026-10-11'));
    shownEachRender.push(onPage());
    page.refresh('ready:2');
    await waitFor(() => expect(page.hook.result.current.page.settling.has(WATER)).toBe(false));
    shownEachRender.push(onPage());

    // Expected [true, true, true]; received [false, false, true]: gone, then back.
    expect(shownEachRender).toEqual([true, true, true]);
  });
});
