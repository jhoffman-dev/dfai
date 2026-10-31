// @vitest-environment jsdom
/**
 * Attacks on #239's settling rule: a row acted on records the index's key as
 * its change begins, and settles only on a read of an index whose key has
 * moved since. The index here answers whatever status it was last told the
 * file has, standing in for an index that is behind the file.
 */
import { describe, expect, it } from 'vitest';
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
import { useToday } from './use-today.ts';

const NOW = Date.UTC(2026, 9, 13, 15);
const CLOCK = { today: () => '2026-10-13', now: () => NOW };
const PATH = createVaultPath('Tasks/Ship the page.md');
const ROW = { path: PATH, title: 'Ship the page' };
const TASK_TEXT = '---\ntype: task\nstatus: next-action\ndue: 2026-10-13\n---\n\n# Ship\n';
const TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

/** What the index holds of the one task: moved by the test, as a refresh would. */
interface Indexed {
  status: string;
  gate: Promise<void> | null;
}

function answer(indexed: Indexed, sql: string): QueryResult {
  if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
    return {
      columns: ['path', 'title', 'modified', 'status', 'due', 'defer'],
      rows: [[PATH, 'Ship the page', NOW, indexed.status, '2026-10-13', null]],
      truncated: false,
    };
  }
  if (sql.startsWith(REVIEW_PROJECTS_QUERY_MARK)) {
    return { columns: ['path', 'title', 'status', 'moving'], rows: [], truncated: false };
  }
  return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
}

interface Props {
  indexKey: string;
  indexReady: boolean;
  vaultKey: string;
  ports: ReturnType<typeof portsOver>;
}

function portsOver(memory: ReturnType<typeof memoryVault>, indexed: Indexed) {
  return {
    index: fakeIndexPort({
      query: async (sql: string) => {
        if (indexed.gate !== null) await indexed.gate;
        return answer(indexed, sql);
      },
    }),
    fs: fakeVaultFs(memory.fs),
    markdown: remarkMarkdown,
  };
}

function setUp() {
  const memory = memoryVault({ [PATH]: TASK_TEXT });
  const indexed: Indexed = { status: 'next-action', gate: null };
  const ports = portsOver(memory, indexed);
  const activity = recordingActivity();
  const onSettled = () => {};
  const hook = renderHook(
    (props: Props) =>
      useToday({
        ports: props.ports,
        editors: noPane,
        activity,
        clock: CLOCK,
        types: TYPES,
        vaultKey: props.vaultKey,
        indexKey: props.indexKey,
        indexReady: props.indexReady,
        open: true,
        onSettled,
      }),
    { initialProps: { indexKey: 'ready:1', indexReady: true, vaultKey: 'vault-a', ports } },
  );
  const text = () => memory.files.get(PATH) ?? '';
  /** New ports over the same index, as the window hands on a re-render: the same vault, read again. */
  const samePortsAgain = (from: Props['ports']) => ({ ...from, fs: fakeVaultFs(memory.fs) });
  return { ...hook, memory, indexed, ports, text, samePortsAgain };
}

const props = (over: Partial<Props> & Pick<Props, 'ports'>): Props => ({
  indexKey: 'ready:1',
  indexReady: true,
  vaultKey: 'vault-a',
  ...over,
});

const statusOf = (text: string) => /status: (\S+)/.exec(text)?.[1];

describe('useToday — attacks on settling by the index key (#239)', () => {
  it('after an undo, a re-read of the index from before the undo still acts on the task as the undo left it', async () => {
    const { result, rerender, indexed, ports, text, samePortsAgain } = setUp();
    await waitFor(() => expect(result.current.page.today).not.toBeNull());

    // Move the task to waiting; the index catches up, and the row settles.
    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'waiting' }));
    indexed.status = 'waiting';
    rerender(props({ ports, indexKey: 'ready:2' }));
    await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(false));
    expect(statusOf(text())).toBe('waiting');

    // Undo: the file is next-action again; the index has not caught up yet.
    await act(async () => result.current.notice?.onUndo());
    await waitFor(() => expect(statusOf(text())).toBe('next-action'));

    // While the undo's refresh is still running, the window hands new ports:
    // the read they start is of the index as it was — still 'waiting', key unmoved.
    const again = samePortsAgain(ports);
    const readBefore = result.current.page.today;
    rerender(props({ ports: again, indexKey: 'ready:2' }));
    await waitFor(() => expect(result.current.page.today).not.toBe(readBefore));

    // The task is next-action in its file; acting on it must not be refused as stale.
    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'someday' }));
    expect(result.current.page.problem).toBeNull();
    expect(statusOf(text())).toBe('someday');
  });

  it('control: after an undo, with no re-read in between, the next action on the row is made', async () => {
    const { result, rerender, indexed, ports, text } = setUp();
    await waitFor(() => expect(result.current.page.today).not.toBeNull());
    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'waiting' }));
    indexed.status = 'waiting';
    rerender(props({ ports, indexKey: 'ready:2' }));
    await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(false));
    await act(async () => result.current.notice?.onUndo());
    await waitFor(() => expect(statusOf(text())).toBe('next-action'));

    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'someday' }));
    expect(result.current.page.problem).toBeNull();
    expect(statusOf(text())).toBe('someday');
  });

  it('holds a row whose read began before its write and lands after it, at the same key', async () => {
    const { result, rerender, indexed, ports, samePortsAgain } = setUp();
    await waitFor(() => expect(result.current.page.today).not.toBeNull());

    let release = () => {};
    indexed.gate = new Promise<void>((resolve) => (release = resolve));
    const again = samePortsAgain(ports);
    rerender(props({ ports: again }));
    // The read is under way and gated; the write lands before it does.
    await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
    expect(result.current.page.settling.has(PATH)).toBe(true);

    indexed.gate = null;
    const readBefore = result.current.page.today;
    await act(async () => release());
    await waitFor(() => expect(result.current.page.today).not.toBe(readBefore));
    expect(result.current.page.settling.has(PATH)).toBe(true);

    rerender(props({ ports: again, indexKey: 'ready:2' }));
    await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(false));
  });

  it('holds a row through a read of a key that moved while its write was still landing', async () => {
    const { result, rerender, ports, indexed } = setUp();
    await waitFor(() => expect(result.current.page.today).not.toBeNull());
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = {
      ...ports,
      fs: {
        ...ports.fs,
        writeTextFile: async (...args: Parameters<typeof ports.fs.writeTextFile>) => {
          await gate;
          return ports.fs.writeTextFile(...args);
        },
      },
    };
    rerender(props({ ports: slow }));
    await waitFor(() => expect(result.current.page.today).not.toBeNull());
    let ticked: Promise<void> = Promise.resolve();
    act(() => {
      ticked = Promise.resolve(result.current.page.onDefer({ ...ROW, days: 1 }));
    });

    // Another file's refresh lands mid-write: the key moves, and its read begins
    // before the write is on disk, and answers only after the write has landed.
    let answerRead = () => {};
    indexed.gate = new Promise<void>((resolve) => (answerRead = resolve));
    const readBefore = result.current.page.today;
    rerender(props({ ports: slow, indexKey: 'ready:2' }));
    await act(async () => {
      release();
      await ticked;
    });
    expect(result.current.page.settling.has(PATH)).toBe(true);
    indexed.gate = null;
    await act(async () => answerRead());
    await waitFor(() => expect(result.current.page.today).not.toBe(readBefore));
    expect(result.current.page.settling.has(PATH)).toBe(true);

    rerender(props({ ports: slow, indexKey: 'ready:3' }));
    await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(false));
  });

  it('keeps a deferred task off the page through a same-key re-read, rather than drawing it back (#260)', async () => {
    const { result, rerender, ports, samePortsAgain } = setUp();
    await waitFor(() => expect(result.current.page.today).not.toBeNull());
    const taskOf = () =>
      result.current.page.today?.sections
        .flatMap((section) => section.groups)
        .flatMap((group) => group.tasks)
        .find((task) => task.path === PATH);
    expect(taskOf()).toBeDefined();
    await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
    expect(taskOf()).toBeUndefined();

    const readBefore = result.current.page.today;
    rerender(props({ ports: samePortsAgain(ports) }));
    await waitFor(() => expect(result.current.page.today).not.toBe(readBefore));
    expect(taskOf()).toBeUndefined();
  });

  it('holds a row through a failed refresh, and settles on the first ready read after it', async () => {
    const { result, rerender, ports } = setUp();
    await waitFor(() => expect(result.current.page.today).not.toBeNull());
    await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
    expect(result.current.page.settling.has(PATH)).toBe(true);

    rerender(props({ ports, indexKey: 'failed:2', indexReady: false }));
    await act(async () => {});
    expect(result.current.page.settling.has(PATH)).toBe(true);
    // What was last read stays on the page while the index is broken.
    expect(result.current.page.today).not.toBeNull();

    rerender(props({ ports, indexKey: 'ready:3' }));
    await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(false));
  });

  it('settles a row ticked while the index was failing, once it is ready again', async () => {
    const { result, rerender, ports } = setUp();
    await waitFor(() => expect(result.current.page.today).not.toBeNull());
    rerender(props({ ports, indexKey: 'failed:2', indexReady: false }));
    await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
    expect(result.current.page.settling.has(PATH)).toBe(true);

    rerender(props({ ports, indexKey: 'ready:3' }));
    await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(false));
  });

  it('a vault switched to mid-tick shows nothing settling and no undo from the vault left', async () => {
    const { result, rerender, ports, memory } = setUp();
    await waitFor(() => expect(result.current.page.today).not.toBeNull());

    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowFs = {
      ...ports.fs,
      writeTextFile: async (...args: Parameters<typeof ports.fs.writeTextFile>) => {
        await gate;
        return ports.fs.writeTextFile(...args);
      },
    };
    const slow = { ...ports, fs: slowFs };
    rerender(props({ ports: slow }));
    await waitFor(() => expect(result.current.page.today).not.toBeNull());
    let ticked: Promise<void> = Promise.resolve();
    act(() => {
      ticked = Promise.resolve(result.current.page.onDefer({ ...ROW, days: 1 }));
    });

    const other = portsOver(memoryVault({}), { status: 'next-action', gate: null });
    rerender(props({ ports: other, vaultKey: 'vault-b', indexKey: 'ready:5' }));
    await act(async () => {
      release();
      await ticked;
    });
    await waitFor(() => expect(memory.files.get(PATH)).toContain('defer'));

    expect(result.current.page.settling.size).toBe(0);
    expect(result.current.notice).toBeNull();
  });

  it('settles on the first read of a moved key even when the write changed nothing the index shows', async () => {
    const { result, rerender, ports } = setUp();
    await waitFor(() => expect(result.current.page.today).not.toBeNull());
    // Moving the task to the status it already has: the file is rewritten the same.
    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'next-action' }));
    expect(result.current.page.settling.has(PATH)).toBe(true);
    rerender(props({ ports, indexKey: 'ready:2' }));
    await waitFor(() => expect(result.current.page.settling.has(PATH)).toBe(false));
  });
});
