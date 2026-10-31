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
import { useToday } from './use-today.ts';

/**
 * Adversarial pass on #111: the Today page's row actions and its one-level
 * undo, against rows gone stale, writes that fail, the day turning, and files
 * written the way people write them.
 */
const NOW = Date.UTC(2026, 9, 13, 15);
const PATH = createVaultPath('Tasks/Call Mara Quill.md');
const OTHER = createVaultPath('Tasks/Write to Tobias Fenn.md');
const ROW = { path: PATH, title: 'Call Mara Quill' };
const OTHER_ROW = { path: OTHER, title: 'Write to Tobias Fenn' };
const TASK_TEXT = '---\ntype: task\nstatus: next-action\ndue: 2026-10-13\n---\n\n# Call\n';
const OTHER_TEXT = '---\ntype: task\nstatus: next-action\n---\n\n# Write\n';
const TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

/** The index as it was when the page read it: it does not follow the files, as a refreshing index does not. */
function answer(sql: string): QueryResult {
  if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
    return {
      columns: ['path', 'title', 'modified', 'status', 'due', 'defer'],
      rows: [
        [PATH, ROW.title, NOW, 'next-action', '2026-10-13', null],
        [OTHER, OTHER_ROW.title, NOW, 'next-action', null, null],
      ],
      truncated: false,
    };
  }
  if (sql.startsWith(REVIEW_PROJECTS_QUERY_MARK)) {
    return { columns: ['path', 'title', 'status', 'moving'], rows: [], truncated: false };
  }
  return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
}

function setUp({ taskText = TASK_TEXT }: { taskText?: string } = {}) {
  const memory = memoryVault({ [PATH]: taskText, [OTHER]: OTHER_TEXT });
  const failNextWrite = { with: null as Error | null };
  const ports = {
    index: fakeIndexPort({ query: async (sql: string) => answer(sql) }),
    fs: fakeVaultFs({
      ...memory.fs,
      writeTextFile: async (write) => {
        const failure = failNextWrite.with;
        failNextWrite.with = null;
        if (failure !== null) throw failure;
        return memory.fs.writeTextFile(write);
      },
    }),
    markdown: remarkMarkdown,
  };
  const day = { today: '2026-10-13' };
  const clock = { today: () => day.today, now: () => NOW };
  const onSettled = vi.fn();
  const hook = renderHook(() =>
    useToday({
      ports,
      editors: noPane,
      activity: recordingActivity(),
      clock,
      types: TYPES,
      vaultKey: 'vault-a',
      indexKey: '1',
      open: true,
      onSettled,
    }),
  );
  return {
    ...hook,
    day,
    onSettled,
    failNextWrite,
    text: () => memory.files.get(PATH) ?? '',
    /** An edit made somewhere else — another pane, the API, a sync — after the page's read. */
    editedElsewhere: (text: string, path: string = PATH) => memory.files.set(path, text),
  };
}

type Page = ReturnType<typeof setUp>['result'];
const shown = async (result: Page) =>
  waitFor(() => expect(result.current.page.today).not.toBeNull());
const offered = async (result: Page) => waitFor(() => expect(result.current.notice).not.toBeNull());
const settled = async (result: Page) => waitFor(() => expect(result.current.page.busy).toBe(false));

describe('useToday: a row gone stale since the page’s read', () => {
  const REPEATING =
    '---\ntype: task\nstatus: next-action\ndue: 2026-10-13\nrecurrence: every week\n---\n\n# Call\n';

  it('does not roll a repeating task on twice when it was ticked elsewhere meanwhile', async () => {
    const { result, text, editedElsewhere } = setUp({ taskText: REPEATING });
    await shown(result);
    // Ticked in another view: already rolled on to the 20th. The page still shows the 13th.
    const rolled = REPEATING.replace(
      'due: 2026-10-13',
      'due: 2026-10-20\nlastCompleted: 2026-10-13',
    );
    editedElsewhere(rolled);

    await act(async () => result.current.page.onDone(ROW));
    await settled(result);

    expect(text()).toBe(rolled);
    expect(result.current.page.problem).not.toBeNull();
  });

  it('does not reopen a task finished elsewhere meanwhile, nor drop the day it was finished', async () => {
    const { result, text, editedElsewhere } = setUp();
    await shown(result);
    const finished = TASK_TEXT.replace('status: next-action', 'status: archive').replace(
      'due: 2026-10-13',
      'due: 2026-10-13\ncompleted: 2026-10-12',
    );
    editedElsewhere(finished);

    await act(async () => result.current.page.onSetStatus({ ...ROW, status: 'someday' }));
    await settled(result);

    expect(text()).toBe(finished);
    expect(result.current.page.problem).not.toBeNull();
  });

  it('says so, writes nothing and offers no undo when the task was deleted meanwhile', async () => {
    const { result, onSettled } = setUp();
    await shown(result);
    await act(async () =>
      result.current.page.onDefer({
        path: createVaultPath('Tasks/Gone.md'),
        title: 'Gone',
        days: 1,
      }),
    );
    await waitFor(() => expect(result.current.page.problem).not.toBeNull());
    expect(result.current.notice).toBeNull();
    expect(onSettled).not.toHaveBeenCalled();
  });
});

describe('useToday: undo gives the file back exactly', () => {
  it('keeps a `completed` the task already held, through a tick and its undo', async () => {
    const taskText = TASK_TEXT.replace('due: 2026-10-13', 'due: 2026-10-13\ncompleted: 2026-09-01');
    const { result, text } = setUp({ taskText });
    await act(async () => result.current.page.onDone(ROW));
    await offered(result);
    await act(async () => result.current.notice?.onUndo());
    await settled(result);
    expect(text()).toBe(taskText);
  });

  const AS_WRITTEN = [
    '---',
    '# kept by hand',
    'type: task',
    'due: "2026-10-13" # the board meets',
    "status: 'in-progress'",
    'recurrence: every month',
    'tags: [larkspur, payroll]',
    'defer: 2026-10-01',
    '---',
    '',
    '# Call',
    '',
  ];

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('restores every byte after tick, move and defer, each undone (%s)', async (_name, ending) => {
    const taskText = AS_WRITTEN.join(ending);
    const { result, text } = setUp({ taskText });
    const actions = [
      () => result.current.page.onDone(ROW),
      () => result.current.page.onSetStatus({ ...ROW, status: 'backlog' }),
      () => result.current.page.onDefer({ ...ROW, days: 7 }),
    ];
    for (const action of actions) {
      await act(async () => action());
      await offered(result);
      expect(text()).not.toBe(taskText);
      await act(async () => result.current.notice?.onUndo());
      await settled(result);
      expect(result.current.page.problem).toBeNull();
      expect(text()).toBe(taskText);
    }
  });

  it('changes only the lines of the keys an action sets', async () => {
    const taskText = AS_WRITTEN.join('\n');
    const { result, text } = setUp({ taskText });
    await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
    await offered(result);
    expect(text()).toBe(taskText.replace('defer: 2026-10-01', 'defer: 2026-10-14'));
  });

  it('rolls a monthly task on from the 31st and back again', async () => {
    const taskText =
      '---\ntype: task\nstatus: waiting\nwaiting_on: Mara Quill\ndue: 2027-01-31\nrecurrence: monthly\n---\n';
    const { result, text } = setUp({ taskText });
    await act(async () => result.current.page.onDone(ROW));
    await offered(result);
    expect(text()).toContain('due: 2027-02-28');
    expect(text()).toContain('status: next-action');
    await act(async () => result.current.notice?.onUndo());
    await settled(result);
    expect(text()).toBe(taskText);
  });

  it('rolls a yearly task on from a leap day and back again', async () => {
    const taskText =
      '---\ntype: task\nstatus: next-action\ndue: 2028-02-29\nrecurrence: yearly\n---\n';
    const { result, text } = setUp({ taskText });
    await act(async () => result.current.page.onDone(ROW));
    await offered(result);
    expect(text()).toContain('due: 2029-02-28');
    await act(async () => result.current.notice?.onUndo());
    await settled(result);
    expect(text()).toBe(taskText);
  });
});

describe('useToday: one level of undo', () => {
  it('still offers to undo the last action after a later one was refused', async () => {
    const { result, text, editedElsewhere } = setUp();
    await act(async () => result.current.page.onDone(ROW));
    await offered(result);

    // Refused: the other row changed since the page read it. Nothing was written.
    editedElsewhere(OTHER_TEXT.replace('next-action', 'someday'), OTHER);
    await act(async () => result.current.page.onSetStatus({ ...OTHER_ROW, status: 'waiting' }));
    await waitFor(() => expect(result.current.page.problem).toMatch(/changed since/));

    expect(text()).toContain('status: archive');
    expect(result.current.notice).toMatchObject({ title: ROW.title });
  });

  it('still offers the undo when writing it failed for a reason that may pass', async () => {
    const { result, text, failNextWrite } = setUp();
    await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
    await offered(result);

    failNextWrite.with = new Error('The disk is busy.');
    await act(async () => result.current.notice?.onUndo());
    await waitFor(() => expect(result.current.page.problem).toBe('The disk is busy.'));

    expect(text()).toContain('defer: 2026-10-14');
    expect(result.current.notice).toMatchObject({ title: ROW.title });
  });

  it('offers no undo for a write that failed half way, and leaves the file alone', async () => {
    const { result, text, failNextWrite, onSettled } = setUp();
    failNextWrite.with = new Error('The disk is full.');
    await act(async () => result.current.page.onDone(ROW));
    await waitFor(() => expect(result.current.page.problem).toBe('The disk is full.'));
    expect(text()).toBe(TASK_TEXT);
    expect(result.current.notice).toBeNull();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('applies one tick when the box is pressed twice in one tick', async () => {
    const taskText =
      '---\ntype: task\nstatus: next-action\ndue: 2026-10-13\nrecurrence: every week\n---\n';
    const { result, text, onSettled } = setUp({ taskText });
    await act(async () => {
      result.current.page.onDone(ROW);
      result.current.page.onDone(ROW);
    });
    await offered(result);
    expect(text()).toContain('due: 2026-10-20');
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('undoes once when Undo is pressed twice in one tick', async () => {
    const { result, text, onSettled } = setUp();
    await act(async () => result.current.page.onDefer({ ...ROW, days: 1 }));
    await offered(result);
    const undo = result.current.notice?.onUndo;
    await act(async () => {
      undo?.();
      undo?.();
    });
    await settled(result);
    expect(text()).toBe(TASK_TEXT);
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(result.current.page.problem).toBeNull();
  });
});

describe('useToday: the day turns while the page is open', () => {
  it('reads again on the new day, so yesterday’s Due today is not still called today', async () => {
    const { result, rerender, day } = setUp();
    await shown(result);
    expect(result.current.page.today?.today).toBe('2026-10-13');

    // Past midnight: the Mac wakes, the window is looked at again, the app renders.
    day.today = '2026-10-14';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    rerender();

    await waitFor(() => expect(result.current.page.today?.today).toBe('2026-10-14'), {
      timeout: 1500,
    });
    const overdue = result.current.page.today?.sections.find((section) => section.id === 'overdue');
    expect(overdue?.count).toBe(1);
  });
});
