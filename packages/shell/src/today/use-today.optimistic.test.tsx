// @vitest-environment jsdom
/**
 * #260: a tick, a move or a defer on the Today page shows at once, before its
 * write lands and the index reads it back. The same use-cases and stale-row
 * guards run (#121); a write that is refused or fails puts the row back,
 * saying why; and a read from before the write never puts it back meanwhile.
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
const SHIP = createVaultPath('Tasks/Ship the page.md');
const CALL = createVaultPath('Tasks/Call the bank.md');
const TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

const taskText = (status: string) => `---\ntype: task\nstatus: ${status}\n---\n\n# A task\n`;

/** A promise and the function that settles it, to hold a write mid-way. */
function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

function today() {
  const memory = memoryVault({ [SHIP]: taskText('in-progress'), [CALL]: taskText('next-action') });
  // What the index holds: each task's status as of the last refresh.
  let indexed = new Map([
    [SHIP, 'in-progress'],
    [CALL, 'next-action'],
  ]);
  let held: Promise<void> | null = null;
  let failing: string | null = null;
  // How many times the page asked for its tasks: once per read.
  let queries = 0;
  const answer = (sql: string): QueryResult => {
    if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
      queries += 1;
      return {
        // As the index answers the page's statement: how each task repeats, too (none here).
        columns: ['path', 'title', 'modified', 'status', 'due', 'defer', 'recurrence'],
        rows: [...indexed].map(([at, status]) => [
          at,
          at.slice(6, -3),
          NOW,
          status,
          null,
          null,
          null,
        ]),
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
        if (failing !== null) throw new Error(failing);
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
    /** The index reads the files again, and says so with a new key. */
    refresh: (indexKey: string) => {
      indexed = new Map(
        [...indexed.keys()].map((at) => [
          at,
          /status: (\S+)/.exec(memory.files.get(at) ?? '')?.[1] ?? '',
        ]),
      );
      hook.rerender({ ...initial, indexKey });
    },
    /**
     * The index stops being ready and is ready again under the same key, so the
     * page reads again — of the index as it still is.
     */
    readAgain: () => {
      hook.rerender({ ...initial, indexReady: false });
      hook.rerender({ ...initial, indexReady: true });
    },
    /** The window hands new ports, as it does each time it lists the tree again. */
    newPorts: () => hook.rerender({ ...initial, ports: { ...ports } }),
    reads: () => queries,
    hold: () => {
      const writes = gate();
      held = writes.opened;
      return () => {
        held = null;
        writes.open();
      };
    },
    fail: (reason: string) => {
      failing = reason;
    },
  };
}

const READY = (page: ReturnType<typeof today>) =>
  waitFor(() => expect(page.hook.result.current.page.today).not.toBeNull());

describe('useToday — an action shows at once (#260)', () => {
  it('takes a ticked task off the page before its write lands', async () => {
    const page = today();
    await READY(page);
    const release = page.hold();

    act(() => page.hook.result.current.page.onDone({ path: SHIP, title: 'Ship the page' }));

    expect(page.titlesIn('inProgress')).toEqual([]);
    expect(page.hook.result.current.page.settling.has(SHIP)).toBe(true);
    expect(page.files.get(SHIP)).toContain('status: in-progress');

    release();
    await waitFor(() => expect(page.files.get(SHIP)).toContain('status: archive'));
    expect(page.titlesIn('inProgress')).toEqual([]);
  });

  it('draws a moved task in the section of its new status before its write lands', async () => {
    const page = today();
    await READY(page);
    const release = page.hold();

    act(() =>
      page.hook.result.current.page.onSetStatus({
        path: CALL,
        title: 'Call the bank',
        status: 'in-progress',
      }),
    );

    expect(page.titlesIn('nextActions')).toEqual([]);
    expect(page.titlesIn('inProgress')).toEqual(['Call the bank', 'Ship the page']);
    release();
    await waitFor(() => expect(page.files.get(CALL)).toContain('status: in-progress'));
  });

  it('takes a deferred task off the page before its write lands', async () => {
    const page = today();
    await READY(page);
    const release = page.hold();

    act(() =>
      page.hook.result.current.page.onDefer({ path: CALL, title: 'Call the bank', days: 1 }),
    );

    expect(page.titlesIn('nextActions')).toEqual([]);
    release();
    await waitFor(() => expect(page.files.get(CALL)).toContain('defer: 2026-10-14'));
  });

  it('keeps the row where its action put it through a read of the index from before the write', async () => {
    const page = today();
    await READY(page);
    await act(async () =>
      page.hook.result.current.page.onDone({ path: SHIP, title: 'Ship the page' }),
    );
    await waitFor(() => expect(page.files.get(SHIP)).toContain('status: archive'));

    const before = page.hook.result.current.page.today;
    page.readAgain();
    await waitFor(() => expect(page.hook.result.current.page.today).not.toBe(before));
    expect(page.titlesIn('inProgress')).toEqual([]);

    page.refresh('ready:2');
    await waitFor(() => expect(page.hook.result.current.page.settling.has(SHIP)).toBe(false));
    expect(page.titlesIn('inProgress')).toEqual([]);
  });

  it('reads nothing again for new ports from the window, only for the index moving (#325)', async () => {
    const page = today();
    await READY(page);
    const read = page.reads();

    page.newPorts();
    page.newPorts();
    await act(() => new Promise((turn) => setTimeout(turn, 0)));
    expect(page.reads()).toBe(read);

    page.refresh('ready:2');
    await waitFor(() => expect(page.reads()).toBe(read + 1));
  });

  it('shows what the index says once it has caught up, even when that is not what the action left', async () => {
    const page = today();
    await READY(page);
    await act(async () =>
      page.hook.result.current.page.onDone({ path: SHIP, title: 'Ship the page' }),
    );
    await waitFor(() => expect(page.files.get(SHIP)).toContain('status: archive'));

    // Another program puts it back under way before the index reads the vault again.
    page.files.set(SHIP, taskText('in-progress'));
    page.refresh('ready:2');

    await waitFor(() => expect(page.titlesIn('inProgress')).toEqual(['Ship the page']));
  });

  it('keeps a moved task the same object through a same-key re-read, so its row is not drawn again', async () => {
    const page = today();
    await READY(page);
    await act(async () =>
      page.hook.result.current.page.onSetStatus({
        path: CALL,
        title: 'Call the bank',
        status: 'in-progress',
      }),
    );
    await waitFor(() => expect(page.files.get(CALL)).toContain('status: in-progress'));
    const movedOf = () =>
      page.hook.result.current.page.today?.sections
        .flatMap((section) => section.groups)
        .flatMap((group) => group.tasks)
        .find((task) => task.path === CALL);
    const before = movedOf();
    expect(before?.status).toBe('in-progress');

    const readBefore = page.hook.result.current.page.today;
    page.readAgain();
    await waitFor(() => expect(page.hook.result.current.page.today).not.toBe(readBefore));
    expect(movedOf()).toBe(before);
  });

  it('puts the row back, saying why, when its write fails', async () => {
    const page = today();
    await READY(page);
    page.fail('The disk is full.');
    const release = page.hold();

    act(() => page.hook.result.current.page.onDone({ path: SHIP, title: 'Ship the page' }));
    expect(page.titlesIn('inProgress')).toEqual([]);

    release();
    await waitFor(() => expect(page.hook.result.current.page.problem).toMatch(/disk is full/));
    expect(page.titlesIn('inProgress')).toEqual(['Ship the page']);
    expect(page.hook.result.current.page.settling.has(SHIP)).toBe(false);
    expect(page.hook.result.current.notice).toBeNull();
  });

  it('puts the row back, saying why, when the task changed since the page read it (#121)', async () => {
    const page = today();
    await READY(page);
    page.files.set(CALL, taskText('someday'));

    await act(async () =>
      page.hook.result.current.page.onSetStatus({
        path: CALL,
        title: 'Call the bank',
        status: 'waiting',
      }),
    );

    await waitFor(() => expect(page.hook.result.current.page.problem).toMatch(/changed since/));
    expect(page.titlesIn('nextActions')).toEqual(['Call the bank']);
    expect(page.titlesIn('waiting')).toEqual([]);
    expect(page.files.get(CALL)).toContain('status: someday');
  });
});
