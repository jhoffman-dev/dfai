// @vitest-environment jsdom
/**
 * #107: a saved query view of tasks asks for each row's task state, and its
 * result is drawn with the rows' controls; a view of several types is not.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, TASK_ROW_COLUMNS, TASK_TYPE_FILE } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, openNote, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useQueryView } from './use-query-view.ts';

const VIEW = createVaultPath('.atlas/views/Next actions.md');
const TASK = 'Tasks/Call Tobias.md';
const TASK_TEXT = '---\ntype: task\nstatus: next-action\n---\n\n# Call Tobias\n';
const viewText = (query: string) => `---\natlas: view\nlayout: list\nquery: ${query}\n---\n`;
const NO_PANE = { setPropertiesIfOpen: async () => false } as unknown as OpenEditors;

async function opened(query: string) {
  const files: Record<string, string> = { [VIEW]: viewText(query), [TASK]: TASK_TEXT };
  const asked: string[] = [];
  const index = fakeIndexPort({
    query: async (sql) => {
      asked.push(sql);
      if (!sql.includes('atlas-query')) return { columns: [], rows: [], truncated: false };
      const carries = sql.includes(`"${TASK_ROW_COLUMNS.status}"`);
      return {
        columns: ['path', 'title', 'type', ...(carries ? [TASK_ROW_COLUMNS.status] : [])],
        rows: [[TASK, 'Call Tobias', 'task', ...(carries ? ['next-action'] : [])]],
        truncated: false,
      };
    },
  });
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({ text: files[path] ?? '', modified: 1 }),
    writeTextFile: async ({ path, contents }) => {
      files[path] = contents;
      return 2;
    },
  });
  const note = await openNote({ fs, markdown: remarkMarkdown, path: VIEW });
  const options = {
    note,
    ports: { index, fs, markdown: remarkMarkdown, editors: NO_PANE, activity: recordingActivity() },
    types: [TASK_TYPE_FILE.type, { name: 'project', label: 'Project', properties: [] }],
    notePaths: [TASK],
    indexKey: 'ready:1',
    queryViews: [],
    dashboards: [],
    viewPaths: [],
    onChanged: () => {},
    onOpenNote: () => {},
    folds: { collapsed: new Set<string>(), onToggle: () => {} },
    queryFold: { store: { read: () => null, write: () => {} }, view: 'v' },
    clock: { today: () => '2026-10-28' },
  };
  const view = renderHook(() => useQueryView(options));
  return { view, asked, files };
}

describe('a saved query view of tasks (#107)', () => {
  it('asks for its rows’ task state and draws them with their controls, which write the task', async () => {
    const { view, asked, files } = await opened('FROM task');
    await waitFor(() => expect(view.result.current?.panel.result?.rows).toHaveLength(1));
    const queries = asked.filter((sql) => sql.includes('atlas-query'));
    expect(queries.at(-1)).toContain(`"${TASK_ROW_COLUMNS.status}"`);
    const result = view.result.current?.panel.result ?? expect.fail('no result');
    const row = result.rows[0] ?? expect.fail('no row');
    expect(result.tasks?.of(row)).toMatchObject({ done: false, chosen: false });

    act(() => result.tasks?.onMove(row, 'waiting'));
    expect(view.result.current?.panel.result?.rows[0]?.values[TASK_ROW_COLUMNS.status]).toBe(
      'waiting',
    );
    await waitFor(() => expect(files[TASK]).toContain('status: waiting'));
  });

  it('leaves the rows of a query of several types look-only', async () => {
    const { view, asked } = await opened('FROM task, project');
    await waitFor(() => expect(view.result.current?.panel.result?.rows).toHaveLength(1));
    const queries = asked.filter((sql) => sql.includes('atlas-query'));
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.at(-1)).not.toContain(TASK_ROW_COLUMNS.status);
    expect(view.result.current?.panel.result?.tasks).toBeUndefined();
  });
});
