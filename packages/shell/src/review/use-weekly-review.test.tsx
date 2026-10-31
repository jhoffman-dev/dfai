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
  NoteChangedError,
  recordingActivity,
  type QueryResult,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useWeeklyReview } from './use-weekly-review.ts';

const ACTIVITY = recordingActivity();

/** P30-07: the weekly review page's reading and quick actions, on a fixed clock. */
const NOW = Date.UTC(2026, 9, 8, 12);
const CLOCK = { today: () => '2026-10-08', now: () => NOW };
const TASK = createVaultPath('Tasks/Ship the review.md');
const PROJECT = createVaultPath('Projects/Garden.md');
const TASK_TEXT = '---\ntype: task\nstatus: next-action\ndue: 2026-10-05\n---\n\n# Ship\n';
const PROJECT_TEXT = '---\ntype: project\nstatus: active\n---\n\n# Garden\n';

const TYPES: readonly ObjectType[] = [
  { name: 'task', label: 'Task', properties: [] },
  {
    name: 'project',
    label: 'Project',
    properties: [
      {
        key: 'status',
        kind: 'select',
        label: 'Status',
        required: false,
        options: ['planned', 'active', 'paused', 'done'],
        target: null,
        many: false,
      },
    ],
  },
];

const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

function answer(sql: string): QueryResult {
  if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
    return {
      columns: ['path', 'title', 'modified', 'status', 'due', 'defer', 'waitingOn', 'project'],
      rows: [[TASK, 'Ship the review', NOW, 'next-action', '2026-10-05', null, null, null]],
      truncated: false,
    };
  }
  if (sql.startsWith(REVIEW_PROJECTS_QUERY_MARK)) {
    return {
      columns: ['path', 'title', 'status'],
      rows: [[PROJECT, 'Garden', 'active']],
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
  changedOnDisk = false,
}: {
  open?: boolean;
  types?: readonly ObjectType[];
  indexReady?: boolean;
  taskText?: string;
  /** The host refuses every write: the note changed on disk since it was read. */
  changedOnDisk?: boolean;
} = {}) {
  const memory = memoryVault({ [TASK]: taskText, [PROJECT]: PROJECT_TEXT });
  const query = vi.fn(async (sql: string) => answer(sql));
  const refused: typeof memory.fs.writeTextFile = async ({ path }) => {
    throw new NoteChangedError(path);
  };
  const ports = {
    index: fakeIndexPort({ query }),
    fs: fakeVaultFs({
      ...memory.fs,
      ...(changedOnDisk && { writeTextFile: refused }),
    }),
    markdown: remarkMarkdown,
  };
  const onSettled = vi.fn();
  const archiveNote = vi.fn(async () => null);
  const hook = renderHook(() =>
    useWeeklyReview({
      ports,
      editors: noPane,
      activity: ACTIVITY,
      clock: CLOCK,
      types,
      indexKey: '1',
      indexReady,
      open,
      onSettled,
      archiveNote,
    }),
  );
  return { ...hook, files: memory.files, query, onSettled, archiveNote };
}

describe('useWeeklyReview', () => {
  it('reads the review while it shows', async () => {
    const { result } = setUp();
    await waitFor(() => expect(result.current.page.review).not.toBeNull());
    expect(result.current.page.review?.overdue.map((task) => task.title)).toEqual([
      'Ship the review',
    ]);
    expect(result.current.page.review?.projectsWithoutNextAction.map((p) => p.title)).toEqual([
      'Garden',
    ]);
  });

  it('reads nothing while it is not showing', () => {
    const { result, query } = setUp({ open: false });
    expect(query).not.toHaveBeenCalled();
    expect(result.current.page.review).toBeNull();
  });

  it('archives a task by finishing it, dated today, then settles', async () => {
    const { result, files, onSettled } = setUp();
    await act(async () => result.current.page.onArchiveTask(TASK));
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(files.get(TASK)).toContain('status: archive');
    expect(files.get(TASK)).toMatch(/completed: \d{4}-\d{2}-\d{2}/);
    expect(result.current.page.problem).toBeNull();
  });

  it('rolls a repeating task on when archived, as ticking it done does, rather than ending it', async () => {
    const taskText =
      '---\ntype: task\nstatus: next-action\ndue: 2026-10-05\nrecurrence: every week\n---\n\n# Ship\n';
    const { result, files, onSettled } = setUp({ taskText });
    await act(async () => result.current.page.onArchiveTask(TASK));
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(files.get(TASK)).toContain('status: next-action');
    expect(files.get(TASK)).toContain('due: 2026-10-12');
    expect(files.get(TASK)).not.toContain('status: archive');
  });

  it('reads and shows nothing while the index builds', () => {
    const { result, query } = setUp({ indexReady: false });
    expect(query).not.toHaveBeenCalled();
    expect(result.current.page.review).toBeNull();
  });

  it('stops showing what it read, actions and all, once the index starts building again', async () => {
    const ports = {
      index: fakeIndexPort({ query: async (sql: string) => answer(sql) }),
      fs: fakeVaultFs(memoryVault({}).fs),
      markdown: remarkMarkdown,
    };
    const { result, rerender } = renderHook(
      ({ indexReady }: { indexReady: boolean }) =>
        useWeeklyReview({
          ports,
          editors: noPane,
          activity: ACTIVITY,
          clock: CLOCK,
          types: TYPES,
          indexKey: indexReady ? 'ready:1' : 'building',
          indexReady,
          open: true,
          onSettled: () => undefined,
          archiveNote: async () => null,
        }),
      { initialProps: { indexReady: true } },
    );
    await waitFor(() => expect(result.current.page.review).not.toBeNull());
    rerender({ indexReady: false });
    expect(result.current.page.review).toBeNull();
  });

  it('defers a task a week from today', async () => {
    const { result, files, onSettled } = setUp();
    await act(async () => result.current.page.onDefer(TASK));
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(files.get(TASK)).toContain('defer: 2026-10-15');
  });

  it('moves a task to another status', async () => {
    const { result, files, onSettled } = setUp();
    await act(async () => result.current.page.onSetStatus({ path: TASK, status: 'someday' }));
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(files.get(TASK)).toContain('status: someday');
  });

  it('moves a task to Waiting with nobody to wait on, asking for no one (#202)', async () => {
    const { result, files, onSettled } = setUp();
    await act(async () => result.current.page.onSetStatus({ path: TASK, status: 'waiting' }));
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(files.get(TASK)).toContain('status: waiting');
    expect(result.current.page.problem).toBeNull();
  });

  it('says why a refused move was not made, and writes nothing', async () => {
    const { result, files, onSettled } = setUp({ changedOnDisk: true });
    await act(async () => result.current.page.onSetStatus({ path: TASK, status: 'someday' }));
    await waitFor(() => expect(result.current.page.problem).toMatch(/changed since/));
    expect(files.get(TASK)).toBe(TASK_TEXT);
    expect(onSettled).not.toHaveBeenCalled();
    expect(result.current.page.busy).toBe(false);
  });

  it("moves a project among its type's statuses", async () => {
    const { result, files, onSettled } = setUp();
    expect(result.current.page.projectStatuses).toEqual(['planned', 'active', 'paused', 'done']);
    await act(async () =>
      result.current.page.onSetProjectStatus({ path: PROJECT, status: 'paused' }),
    );
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(files.get(PROJECT)).toBe('---\ntype: project\nstatus: paused\n---\n\n# Garden\n');
  });

  it("archives a project through the app's Archive", async () => {
    const { result, archiveNote, files } = setUp();
    await act(async () => result.current.page.onArchiveProject(PROJECT));
    expect(archiveNote).toHaveBeenCalledWith(PROJECT);
    expect(files.get(PROJECT)).toBe(PROJECT_TEXT);
  });

  it('acts once when asked twice in one tick', async () => {
    const { result, archiveNote } = setUp();
    await act(async () => {
      result.current.page.onArchiveProject(PROJECT);
      result.current.page.onArchiveProject(PROJECT);
    });
    expect(archiveNote).toHaveBeenCalledTimes(1);
  });

  it('is offered once the vault has tasks', () => {
    expect(setUp().result.current.shown).toBe(true);
    expect(setUp({ types: TYPES.slice(1) }).result.current.shown).toBe(false);
  });

  it('finds the Task type however its name is cased, as taskTypeOf does', () => {
    const cased = [{ ...TYPES[0]!, name: 'Task' }, ...TYPES.slice(1)];
    expect(setUp({ types: cased }).result.current.shown).toBe(true);
  });
});
