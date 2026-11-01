// @vitest-environment jsdom
/**
 * #107: a query view's row and a Today row make one change. The same task,
 * acted on the same way from each, leaves its file byte for byte the same —
 * a tick, a repeating task's roll with the day's choice ended, a move, and a
 * choice for today.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  createVaultPath,
  REVIEW_PROJECTS_QUERY_MARK,
  REVIEW_TASKS_QUERY_MARK,
  splitFrontmatter,
  TASK_ROW_COLUMNS,
  TASK_TYPE_FILE,
  taskAsRead,
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
import { useToday } from '../today/use-today.ts';
import { useTaskRows } from './use-task-rows.ts';

const TODAY = '2026-10-28';
const NOW = Date.UTC(2026, 9, 28, 15);
const CLOCK = { today: () => TODAY, now: () => NOW };
const PATH = createVaultPath('Tasks/Water the beds.md');
const TITLE = 'Water the beds';
const TYPES = [TASK_TYPE_FILE.type];
const noPane = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

type Act =
  | { readonly kind: 'done' }
  | { readonly kind: 'move'; readonly status: 'waiting' }
  | { readonly kind: 'choose' };

/** What the file says, as both pages' reads of the index take it. */
function asRead(text: string) {
  const { frontmatter } = splitFrontmatter(text);
  const properties = frontmatter === null ? {} : remarkMarkdown.frontmatterProperties(frontmatter);
  const recurrence = properties['recurrence'];
  return {
    ...taskAsRead(properties),
    recurrence: typeof recurrence === 'string' ? recurrence : null,
  };
}

async function fromToday(text: string, action: Act): Promise<string | undefined> {
  const memory = memoryVault({ [PATH]: text });
  const task = asRead(text);
  const answer = (sql: string): QueryResult => {
    if (sql.startsWith(REVIEW_TASKS_QUERY_MARK)) {
      return {
        columns: [
          'path',
          'title',
          'modified',
          'status',
          'due',
          'defer',
          'focus',
          'focusIsOwn',
          'recurrence',
        ],
        rows: [[PATH, TITLE, NOW, task.status, task.due, null, task.focus, 0, task.recurrence]],
        truncated: false,
      };
    }
    if (sql.startsWith(REVIEW_PROJECTS_QUERY_MARK)) {
      return { columns: ['path', 'title', 'status', 'moving'], rows: [], truncated: false };
    }
    return { columns: ['path', 'title', 'type'], rows: [], truncated: false };
  };
  const options = {
    ports: {
      index: fakeIndexPort({ query: async (sql: string) => answer(sql) }),
      fs: fakeVaultFs(memory.fs),
      markdown: remarkMarkdown,
    },
    editors: noPane,
    activity: recordingActivity(),
    clock: CLOCK,
    types: TYPES,
    vaultKey: 'vault-a',
    indexKey: 'ready:1',
    indexKeyNow: () => 'ready:1',
    open: true,
    onSettled: () => {},
  };
  const hook = renderHook(() => useToday(options));
  await waitFor(() => expect(hook.result.current.page.today).not.toBeNull());
  const page = hook.result.current.page;
  const row = { path: PATH, title: TITLE };
  act(() => {
    if (action.kind === 'done') page.onDone(row);
    else if (action.kind === 'move') page.onSetStatus({ ...row, status: action.status });
    else page.onChoose({ ...row, choice: 'choose' });
  });
  await waitFor(() => expect(memory.files.get(PATH)).not.toBe(text));
  return memory.files.get(PATH);
}

async function fromQueryView(text: string, action: Act): Promise<string | undefined> {
  const memory = memoryVault({ [PATH]: text });
  const task = asRead(text);
  const row = {
    path: PATH,
    title: TITLE,
    values: {
      [TASK_ROW_COLUMNS.status]: task.status,
      [TASK_ROW_COLUMNS.due]: task.due,
      [TASK_ROW_COLUMNS.defer]: null,
      [TASK_ROW_COLUMNS.focus]: task.focus,
      [TASK_ROW_COLUMNS.focusIsOwn]: 0,
      [TASK_ROW_COLUMNS.recurrence]: task.recurrence,
    },
  };
  const options = {
    rows: [row],
    read: { at: 1, indexKey: 'ready:1' },
    runsBegun: () => 1,
    indexKeyNow: () => 'ready:1',
    enabled: true,
    scope: ['index', 'Views/Next actions.md'],
    ports: {
      fs: fakeVaultFs(memory.fs),
      markdown: remarkMarkdown,
      editors: noPane,
      activity: recordingActivity(),
    },
    clock: CLOCK,
    types: TYPES,
    onChanged: () => {},
  };
  const hook = renderHook(() => useTaskRows(options));
  const controls = hook.result.current.controls ?? expect.fail('no controls');
  act(() => {
    if (action.kind === 'done') controls.onDone(row, true);
    else if (action.kind === 'move') controls.onMove(row, action.status);
    else controls.onToday(row, false);
  });
  await waitFor(() => expect(memory.files.get(PATH)).not.toBe(text));
  return memory.files.get(PATH);
}

const PLAIN = `---\ntype: task\nstatus: next-action # water at dawn\n---\n\n# Water the beds\n`;
const REPEATING = `---\ntype: task\nstatus: "next-action"\ndue: 2026-10-28\nrecurrence: every week\nfocus: ${TODAY}\n---\n\nBody.\n`;

describe('a query view’s row and a Today row write the same bytes (#107)', () => {
  it.each([
    ['ticked done', PLAIN, { kind: 'done' } as const],
    ['a repeating task chosen for today, ticked', REPEATING, { kind: 'done' } as const],
    ['moved to Waiting', PLAIN, { kind: 'move', status: 'waiting' } as const],
    ['chosen for today', PLAIN, { kind: 'choose' } as const],
  ])('%s', async (_name, text, action) => {
    const today = await fromToday(text, action);
    const view = await fromQueryView(text, action);
    expect(today).toBeDefined();
    expect(view).toBe(today);
  });
});
