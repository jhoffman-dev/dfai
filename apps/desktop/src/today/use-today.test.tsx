// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  createVaultPath,
  FOCUS_PROPERTY,
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
import { settles } from '@dfai/ui/testing/settles';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useToday } from './use-today.ts';

/** #111: the Today page's reading, row actions and undo, on a fixed clock. */
const NOW = Date.UTC(2026, 9, 13, 15);
const CLOCK = { today: () => '2026-10-13', now: () => NOW };
const PATH = createVaultPath('Tasks/Ship the page.md');
const ROW = { path: PATH, title: 'Ship the page' };
const TASK_TEXT = '---\ntype: task\nstatus: next-action\ndue: 2026-10-13\n---\n\n# Ship\n';

// The Task type as the vault opening gives it `focus` (#108), so the page chooses.
const TYPES: readonly ObjectType[] = [
  { name: 'task', label: 'Task', properties: [FOCUS_PROPERTY] },
];

const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

function answer(sql: string, focus: string | null = null): QueryResult {
  if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
    return {
      columns: ['path', 'title', 'modified', 'status', 'due', 'defer', 'focus'],
      rows: [[PATH, 'Ship the page', NOW, 'next-action', '2026-10-13', null, focus]],
      truncated: false,
    };
  }
  if (sql.startsWith(REVIEW_PROJECTS_QUERY_MARK)) {
    return {
      columns: ['path', 'title', 'status', 'moving'],
      rows: [['Projects/Garden.md', 'Garden', 'active', 0]],
      truncated: false,
    };
  }
  return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
}

function setUp({
  open = true,
  types = TYPES,
  indexReady = true,
  taskText = TASK_TEXT,
  indexedFocus = null,
}: {
  open?: boolean;
  types?: readonly ObjectType[];
  indexReady?: boolean;
  taskText?: string;
  /** The `focus` the index holds for the task. */
  indexedFocus?: string | null;
} = {}) {
  const memory = memoryVault({ [PATH]: taskText });
  const query = vi.fn(async (sql: string) => answer(sql, indexedFocus));
  const ports = {
    index: fakeIndexPort({ query }),
    fs: fakeVaultFs(memory.fs),
    markdown: remarkMarkdown,
  };
  const onSettled = vi.fn();
  const activity = recordingActivity();
  const hook = renderHook(() =>
    useToday({
      ports,
      editors: noPane,
      activity,
      clock: CLOCK,
      types,
      vaultKey: 'vault-a',
      indexKey: '1',
      indexReady,
      open,
      onSettled,
    }),
  );
  const text = () => memory.files.get(PATH) ?? '';
  return { ...hook, text, files: memory.files, query, onSettled, activity };
}

describe('useToday', () => {
  it('reads the day while the page shows', async () => {
    const { result } = setUp();
    await waitFor(() => expect(result.current.page.today).not.toBeNull());
    const today = result.current.page.today;
    expect(today?.today).toBe('2026-10-13');
    const due = today?.sections.find((section) => section.id === 'dueToday');
    expect(due?.groups[0]?.tasks.map((task) => task.title)).toEqual(['Ship the page']);
    expect(today?.stalledProjects).toBe(1);
  });

  it('reads nothing while the page is not showing, or the index builds', () => {
    for (const closed of [{ open: false }, { indexReady: false }]) {
      const { result, query } = setUp(closed);
      expect(query).not.toHaveBeenCalled();
      expect(result.current.page.today).toBeNull();
    }
  });

  it('is offered only in a vault that has tasks', () => {
    expect(setUp().result.current.shown).toBe(true);
    expect(setUp({ types: [] }).result.current.shown).toBe(false);
  });

  it('ticks a task done, dated on the page’s clock, settles, and offers to take it back', async () => {
    const { result, text, onSettled } = setUp();
    await act(async () => result.current.page.onDone(ROW));
    await waitFor(() => expect(result.current.notice).not.toBeNull());
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(text()).toContain('status: archive');
    expect(text()).toContain('completed: 2026-10-13');
    expect(result.current.notice).toMatchObject({
      title: 'Ship the page',
      action: { kind: 'done' },
    });
  });

  it('rolls a repeating task on when ticked, as a type’s view does', async () => {
    const taskText =
      '---\ntype: task\nstatus: next-action\ndue: 2026-10-13\nrecurrence: every week\n---\n\n# Ship\n';
    const { result, text } = setUp({ taskText });
    await act(async () => result.current.page.onDone(ROW));
    await waitFor(() => expect(result.current.notice).not.toBeNull());
    expect(text()).toContain('status: next-action');
    expect(text()).toContain('due: 2026-10-20');
    expect(text()).not.toContain('archive');
  });

  it.each([
    [1, '2026-10-14'],
    [7, '2026-10-20'],
  ])('defers a task %i day(s) from the clock’s today', async (days, day) => {
    const { result, text } = setUp();
    await act(async () => result.current.page.onDefer({ ...ROW, days }));
    await waitFor(() => expect(result.current.notice).not.toBeNull());
    expect(text()).toContain(`defer: ${day}`);
    expect(result.current.notice?.action).toEqual({ kind: 'defer', days });
  });

  it('chooses a task for the clock’s today, draws it under Chosen at once, and undoes it byte for byte (#108)', async () => {
    const { result, text, onSettled } = setUp();
    await waitFor(() => expect(result.current.page.today).not.toBeNull());
    await act(async () => result.current.page.onChoose({ ...ROW, choice: 'choose' }));
    await waitFor(() => expect(result.current.notice).not.toBeNull());
    expect(text()).toBe(
      TASK_TEXT.replace('due: 2026-10-13\n', 'due: 2026-10-13\nfocus: 2026-10-13\n'),
    );
    expect(result.current.notice?.action).toEqual({ kind: 'choose' });
    const chosen = result.current.page.today?.sections.find((section) => section.id === 'chosen');
    expect(chosen?.groups[0]?.tasks.map((task) => task.title)).toEqual(['Ship the page']);

    await act(async () => result.current.notice?.onUndo());
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2));
    expect(text()).toBe(TASK_TEXT);
  });

  it.each([
    ['unchoose', 'focus: 2026-10-13'],
    ['drop', 'focus: 2026-10-12'],
  ] as const)(
    'takes focus out to %s a task, leaving the rest as written',
    async (choice, focus) => {
      const taskText = TASK_TEXT.replace('due: 2026-10-13\n', `due: 2026-10-13\n${focus}\n`);
      const { result, text } = setUp({ taskText });
      await act(async () => result.current.page.onChoose({ ...ROW, choice }));
      await waitFor(() => expect(result.current.notice).not.toBeNull());
      expect(text()).toBe(TASK_TEXT);
      expect(result.current.notice?.action).toEqual({ kind: choice });
    },
  );

  it('moves a choice made for a later day to today, saying the day it was (#108)', async () => {
    const taskText = TASK_TEXT.replace('due: 2026-10-13\n', 'due: 2026-10-13\nfocus: 2026-10-20\n');
    const { result, text } = setUp({ taskText, indexedFocus: '2026-10-20' });
    await waitFor(() => expect(result.current.page.today).not.toBeNull());
    await act(async () =>
      result.current.page.onChoose({ ...ROW, choice: 'choose', was: '2026-10-20' }),
    );
    await waitFor(() => expect(result.current.notice).not.toBeNull());
    expect(text()).toContain('focus: 2026-10-13');
    expect(result.current.notice?.action).toEqual({ kind: 'choose', was: '2026-10-20' });
  });

  it('offers no choosing, and writes none, in a vault whose Task type has no focus as a date (#108)', async () => {
    const { result, text } = setUp({ types: [{ name: 'task', label: 'Task', properties: [] }] });
    await waitFor(() => expect(result.current.page.today).not.toBeNull());
    expect(result.current.page.today?.choosing).toBe(false);
    await act(async () => result.current.page.onChoose({ ...ROW, choice: 'choose' }));
    expect(text()).toBe(TASK_TEXT);
    expect(result.current.notice).toBeNull();
  });

  it('takes a chosen task’s focus out with its tick, and gives it back byte for byte on Undo (#108)', async () => {
    const taskText = TASK_TEXT.replace(
      'due: 2026-10-13\n',
      'due: 2026-10-13\nfocus: "2026-10-13" # chosen at breakfast\n',
    );
    const { result, text, onSettled } = setUp({ taskText, indexedFocus: '2026-10-13' });
    await waitFor(() => expect(result.current.page.today).not.toBeNull());
    await act(async () => result.current.page.onDone(ROW));
    await waitFor(() => expect(result.current.notice).not.toBeNull());
    expect(text()).toContain('status: archive');
    expect(text()).not.toContain('focus');

    await act(async () => result.current.notice?.onUndo());
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2));
    expect(text()).toBe(taskText);
  });

  it('moves a task to another status', async () => {
    const { result, text } = setUp();
    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'someday' }));
    await waitFor(() => expect(result.current.notice).not.toBeNull());
    expect(text()).toContain('status: someday');
    expect(result.current.notice?.action).toEqual({ kind: 'move', status: 'someday' });
  });

  it('moves a task to Waiting with nobody to wait on, asking for no one (#202)', async () => {
    const { result, text, onSettled, activity } = setUp();
    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'waiting' }));
    await waitFor(() => expect(result.current.notice).not.toBeNull());
    expect(text()).toBe(TASK_TEXT.replace('status: next-action', 'status: waiting'));
    expect(result.current.page.problem).toBeNull();
    expect(onSettled).toHaveBeenCalled();
    expect(result.current.notice?.action).toEqual({ kind: 'move', status: 'waiting' });
    expect(activity.reports).toEqual([]);
  });

  it('says why a refused move was not made, writes nothing, and it is no fault', async () => {
    const { result, text, files, onSettled, activity } = setUp();
    await waitFor(() => expect(result.current.page.today).not.toBeNull());
    const elsewhere = TASK_TEXT.replace('next-action', 'someday');
    files.set(PATH, elsewhere);
    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'waiting' }));
    await waitFor(() => expect(result.current.page.problem).toMatch(/changed since/));
    expect(text()).toBe(elsewhere);
    expect(onSettled).not.toHaveBeenCalled();
    expect(result.current.notice).toBeNull();
    expect(activity.reports).toEqual([]);
  });

  it('keeps one notice object across renders, so its bar keeps its time (review)', async () => {
    const { result, rerender } = setUp();
    await act(async () => result.current.page.onDone(ROW));
    await waitFor(() => expect(result.current.notice).not.toBeNull());
    const shown = result.current.notice;
    rerender();
    expect(result.current.notice).toBe(shown);
  });

  it('undoes the last action, giving the file back as it was', async () => {
    const { result, text, onSettled } = setUp();
    await act(async () => result.current.page.onDone(ROW));
    await waitFor(() => expect(result.current.notice).not.toBeNull());

    await act(async () => result.current.notice?.onUndo());
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2));
    expect(text()).toBe(TASK_TEXT);
    expect(result.current.notice).toBeNull();
    expect(result.current.page.problem).toBeNull();
  });

  it('gives a key back as it was written, where its value alone would be written another way', async () => {
    // A one-item list on one line: written from its value, it comes back as a block list.
    const taskText = '---\ntype: task\nstatus: next-action\ndefer: [2026-10-01]\n---\n\n# Ship\n';
    const { result, text } = setUp({ taskText });
    await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
    await waitFor(() => expect(result.current.notice).not.toBeNull());
    expect(text()).toContain('defer: 2026-10-14');
    await act(async () => result.current.notice?.onUndo());
    await waitFor(() => expect(result.current.notice).toBeNull());
    expect(text()).toBe(taskText);
  });

  it('will not undo over a later edit, says so, and keeps the edit', async () => {
    const { result, text, files } = setUp();
    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'someday' }));
    await waitFor(() => expect(result.current.notice).not.toBeNull());
    const edited = text().replace('status: someday', 'status: backlog');
    files.set(PATH, edited);

    await act(async () => result.current.notice?.onUndo());
    await waitFor(() => expect(result.current.page.problem).toMatch(/changed since/));
    expect(text()).toBe(edited);
  });

  it('forgets the last action when it is dismissed', async () => {
    const { result } = setUp();
    await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
    await waitFor(() => expect(result.current.notice).not.toBeNull());
    act(() => result.current.notice?.onDismiss());
    expect(result.current.notice).toBeNull();
  });

  it('says what the index could not answer', async () => {
    const ports = {
      index: fakeIndexPort({ query: () => Promise.reject(new Error('the index is closed')) }),
      fs: fakeVaultFs(memoryVault({}).fs),
      markdown: remarkMarkdown,
    };
    const { result } = renderHook(() =>
      useToday({
        ports,
        editors: noPane,
        activity: recordingActivity(),
        clock: CLOCK,
        types: TYPES,
        vaultKey: 'vault-a',
        indexKey: '1',
        open: true,
        onSettled: () => {},
      }),
    );
    await waitFor(() => expect(result.current.page.error).toBe('the index is closed'));
    expect(result.current.page.today).toBeNull();
  });

  describe('a row that has been acted on', () => {
    function mounted() {
      const memory = memoryVault({ [PATH]: TASK_TEXT });
      const ports = {
        index: fakeIndexPort({ query: async (sql: string) => answer(sql) }),
        fs: fakeVaultFs(memory.fs),
        markdown: remarkMarkdown,
      };
      const activity = recordingActivity();
      const onSettled = vi.fn();
      const hook = renderHook(
        ({ indexKey }: { indexKey: string }) =>
          useToday({
            ports,
            editors: noPane,
            activity,
            clock: CLOCK,
            types: TYPES,
            vaultKey: 'vault-a',
            open: true,
            onSettled,
            indexKey,
          }),
        { initialProps: { indexKey: '1' } },
      );
      return { ...hook, onSettled, files: memory.files, text: () => memory.files.get(PATH) ?? '' };
    }

    it('takes no other action until a read made after its write is on the page', async () => {
      const { result, rerender, onSettled, text } = mounted();
      await waitFor(() => expect(result.current.page.today).not.toBeNull());
      await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
      await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(true));
      const deferred = text();

      // The row still shows the task as it was; a second press must not act on that.
      await act(async () => result.current.page.onDefer({ ...ROW, days: 7 }));
      await act(async () => result.current.page.onDone(ROW));
      expect(text()).toBe(deferred);
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(result.current.page.problem).toBeNull();

      rerender({ indexKey: '2' });
      await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(false));
    });

    it('stays held through a read of the index from before its write, and settles once the index moves (#239)', async () => {
      const memory = memoryVault({ [PATH]: TASK_TEXT });
      const portsOver = () => ({
        index: fakeIndexPort({ query: async (sql: string) => answer(sql) }),
        fs: fakeVaultFs(memory.fs),
        markdown: remarkMarkdown,
      });
      const first = portsOver();
      const activity = recordingActivity();
      const { result, rerender } = renderHook(
        ({ indexKey, ports }: { indexKey: string; ports: ReturnType<typeof portsOver> }) =>
          useToday({
            ports,
            editors: noPane,
            activity,
            clock: CLOCK,
            types: TYPES,
            vaultKey: 'vault-a',
            open: true,
            onSettled: () => {},
            indexKey,
          }),
        { initialProps: { indexKey: '1', ports: first } },
      );
      await waitFor(() => expect(result.current.page.today).not.toBeNull());
      await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
      await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(true));

      // The window hands new ports while the refresh the write asked for is still
      // running: the read they start is of the index as it was, so the row is not
      // yet what its task is.
      const again = { ...first, fs: fakeVaultFs(memory.fs) };
      const readBefore = result.current.page.today;
      rerender({ indexKey: '1', ports: again });
      await waitFor(() => expect(result.current.page.today).not.toBe(readBefore));
      expect(result.current.page.settling.has(PATH)).toBe(true);

      rerender({ indexKey: '2', ports: again });
      await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(false));
    });

    it('stops being held when the next read fails: the page shows the failure, not a frozen row', async () => {
      const memory = memoryVault({ [PATH]: TASK_TEXT });
      const index = { failing: false };
      const ports = {
        index: fakeIndexPort({
          query: async (sql: string) => {
            if (index.failing) throw new Error('the index is closed');
            return answer(sql);
          },
        }),
        fs: fakeVaultFs(memory.fs),
        markdown: remarkMarkdown,
      };
      const activity = recordingActivity();
      const onSettled = () => {};
      const { result, rerender } = renderHook(
        ({ indexKey }: { indexKey: string }) =>
          useToday({
            ports,
            editors: noPane,
            activity,
            clock: CLOCK,
            types: TYPES,
            vaultKey: 'vault-a',
            open: true,
            onSettled,
            indexKey,
          }),
        { initialProps: { indexKey: '1' } },
      );
      await waitFor(() => expect(result.current.page.today).not.toBeNull());
      await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
      await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(true));

      index.failing = true;
      rerender({ indexKey: '2' });
      await waitFor(() => expect(result.current.page.error).toBe('the index is closed'));
      expect(result.current.page.settling.has(PATH)).toBe(false);
    });

    it('holds the row, with no undo on offer, when its change was written but could not be read back', async () => {
      const memory = memoryVault({ [PATH]: TASK_TEXT });
      let reads = 0;
      const ports = {
        index: fakeIndexPort({ query: async (sql: string) => answer(sql) }),
        fs: fakeVaultFs({
          ...memory.fs,
          // The look before the write, the write's own read, then the look after it.
          readTextFile: async (path) => {
            reads += 1;
            if (reads === 3) throw new Error('The disk is busy.');
            return memory.fs.readTextFile(path);
          },
        }),
        markdown: remarkMarkdown,
      };
      const activity = recordingActivity();
      const onSettled = vi.fn();
      const { result } = renderHook(() =>
        useToday({
          ports,
          editors: noPane,
          activity,
          clock: CLOCK,
          types: TYPES,
          vaultKey: 'vault-a',
          indexKey: '1',
          open: true,
          onSettled,
        }),
      );
      await waitFor(() => expect(result.current.page.today).not.toBeNull());
      await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
      await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(true));
      expect(memory.files.get(PATH)).toContain('defer: 2026-10-14');
      expect(result.current.notice).toBeNull();
      expect(result.current.page.problem).toBeNull();
      expect(onSettled).toHaveBeenCalledTimes(1);
    });

    it('is free again once its change is undone', async () => {
      const { result } = mounted();
      await waitFor(() => expect(result.current.page.today).not.toBeNull());
      await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
      await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(true));
      await act(async () => result.current.notice?.onUndo());
      await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(false));
    });

    it('is not held when its action was refused', async () => {
      const { result, files } = mounted();
      await waitFor(() => expect(result.current.page.today).not.toBeNull());
      files.set(PATH, TASK_TEXT.replace('next-action', 'someday'));
      await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'waiting' }));
      await waitFor(() => expect(result.current.page.problem).not.toBeNull());
      expect(result.current.page.settling.size).toBe(0);
    });
  });

  describe('the day turning', () => {
    it('reads again within a minute of the clock’s day changing, with nobody looking', async () => {
      vi.useFakeTimers({ now: NOW });
      try {
        const day = { today: '2026-10-13' };
        const clock = { today: () => day.today, now: () => NOW };
        const ports = {
          index: fakeIndexPort({ query: async (sql: string) => answer(sql) }),
          fs: fakeVaultFs(memoryVault({ [PATH]: TASK_TEXT }).fs),
          markdown: remarkMarkdown,
        };
        const activity = recordingActivity();
        const onSettled = () => {};
        const { result } = renderHook(() =>
          useToday({
            ports,
            editors: noPane,
            activity,
            clock,
            types: TYPES,
            vaultKey: 'vault-a',
            indexKey: '1',
            open: true,
            onSettled,
          }),
        );
        await settles(() => expect(result.current.page.today?.today).toBe('2026-10-13'));

        day.today = '2026-10-14';
        await act(async () => vi.advanceTimersByTimeAsync(59_000));
        expect(result.current.page.today?.today).toBe('2026-10-13');
        await act(async () => vi.advanceTimersByTimeAsync(2_000));
        await settles(() => expect(result.current.page.today?.today).toBe('2026-10-14'));
        const overdue = result.current.page.today?.sections.find(({ id }) => id === 'overdue');
        expect(overdue?.count).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('while the vault changes under it', () => {
    function mounted() {
      const memory = memoryVault({ [PATH]: TASK_TEXT });
      const query = vi.fn(async (sql: string) => answer(sql));
      const ports = {
        index: fakeIndexPort({ query }),
        fs: fakeVaultFs(memory.fs),
        markdown: remarkMarkdown,
      };
      const activity = recordingActivity();
      const onSettled = () => {};
      const hook = renderHook(
        (given: { vaultKey: string; indexReady: boolean; indexKey: string }) =>
          useToday({
            ports,
            editors: noPane,
            activity,
            clock: CLOCK,
            types: TYPES,
            open: true,
            onSettled,
            ...given,
          }),
        { initialProps: { vaultKey: 'vault-a', indexReady: true, indexKey: '1' } },
      );
      return { ...hook, query };
    }

    it('keeps the page, and its undo, on screen while the index is refreshed, then reads again', async () => {
      const { result, rerender, query } = mounted();
      await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
      await waitFor(() => expect(result.current.notice).not.toBeNull());
      const shown = result.current.page.today;
      expect(shown).not.toBeNull();
      const asked = query.mock.calls.length;

      rerender({ vaultKey: 'vault-a', indexReady: false, indexKey: '1' });
      expect(result.current.page.today).toBe(shown);
      expect(result.current.notice).not.toBeNull();
      expect(query.mock.calls.length).toBe(asked);

      rerender({ vaultKey: 'vault-a', indexReady: true, indexKey: '2' });
      await waitFor(() => expect(result.current.page.today).not.toBe(shown));
      expect(query.mock.calls.length).toBeGreaterThan(asked);
    });

    it('shows nothing of one vault, and offers no undo, once another is open', async () => {
      const { result, rerender } = mounted();
      await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
      await waitFor(() => expect(result.current.notice).not.toBeNull());

      rerender({ vaultKey: 'vault-b', indexReady: false, indexKey: '1' });
      expect(result.current.page.today).toBeNull();
      expect(result.current.notice).toBeNull();
    });
  });

  it('stops showing a read, and its undo, once another vault’s index is the one open', async () => {
    const memory = memoryVault({ [PATH]: TASK_TEXT });
    const portsFor = () => ({
      index: fakeIndexPort({ query: async (sql: string) => answer(sql) }),
      fs: fakeVaultFs(memory.fs),
      markdown: remarkMarkdown,
    });
    const first = portsFor();
    const never = { ...portsFor(), index: fakeIndexPort({ query: () => new Promise(() => {}) }) };
    const activity = recordingActivity();
    const { result, rerender } = renderHook(
      ({ ports }: { ports: typeof first }) =>
        useToday({
          ports,
          editors: noPane,
          activity,
          clock: CLOCK,
          types: TYPES,
          vaultKey: 'vault-a',
          indexKey: '1',
          open: true,
          onSettled: () => {},
        }),
      { initialProps: { ports: first } },
    );
    await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
    await waitFor(() => expect(result.current.notice).not.toBeNull());
    expect(result.current.page.today).not.toBeNull();

    rerender({ ports: never });
    expect(result.current.page.today).toBeNull();
    expect(result.current.notice).toBeNull();
  });
});

describe('useToday — a read again (#217)', () => {
  const OTHER = createVaultPath('Tasks/Call the bank.md');

  /** The day's tasks as the index answers, `dueOfOther` the one thing that changes. */
  function twoTasks(dueOfOther: string) {
    return async (sql: string): Promise<QueryResult> =>
      sql.startsWith(REVIEW_TASKS_QUERY_MARK)
        ? {
            columns: ['path', 'title', 'modified', 'status', 'due', 'defer'],
            rows: [
              [PATH, 'Ship the page', NOW, 'next-action', '2026-10-13', null],
              [OTHER, 'Call the bank', NOW, 'next-action', dueOfOther, null],
            ],
            truncated: false,
          }
        : answer(sql);
  }

  function reading() {
    let query = twoTasks('2026-10-13');
    const ports = {
      index: fakeIndexPort({ query: (sql) => query(sql) }),
      fs: fakeVaultFs(memoryVault({}).fs),
      markdown: remarkMarkdown,
    };
    const hook = renderHook(
      ({ indexKey }: { indexKey: string }) =>
        useToday({
          ports,
          editors: noPane,
          activity: recordingActivity(),
          clock: CLOCK,
          types: TYPES,
          vaultKey: 'vault-a',
          indexKey,
          open: true,
          onSettled: vi.fn(),
        }),
      { initialProps: { indexKey: '1' } },
    );
    const taskOf = (path: string) =>
      hook.result.current.page.today?.sections
        .flatMap((section) => section.groups.flatMap((group) => group.tasks))
        .find((task) => task.path === path);
    return { hook, taskOf, answerNext: (next: typeof query) => (query = next) };
  }

  it('keeps each task that did not change the same, so its row is not drawn again', async () => {
    const { hook, taskOf, answerNext } = reading();
    await waitFor(() => expect(taskOf(OTHER)).toBeDefined());
    const [shipBefore, callBefore] = [taskOf(PATH), taskOf(OTHER)];
    const before = hook.result.current.page.today;

    answerNext(twoTasks('2026-10-01'));
    hook.rerender({ indexKey: '2' });
    await waitFor(() => expect(hook.result.current.page.today).not.toBe(before));

    expect(taskOf(PATH)).toBe(shipBefore);
    expect(taskOf(OTHER)).not.toBe(callBefore);
    expect(taskOf(OTHER)?.due).toBe('2026-10-01');
  });
});
