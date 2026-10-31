// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, type ObjectType, type VaultPath } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, openNote, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useQueryPage } from './use-query-page.ts';
import { useSqlView } from './use-sql-view.ts';

const DASHBOARD = createVaultPath('.atlas/dashboards/Home.md');
const HOME = ['---', 'atlas: dashboard', 'widgets: []', '---', '', '# Home', ''].join('\n');

const COUNTS = {
  columns: ['status', 'n'],
  rows: [
    ['doing', 2],
    ['backlog', 6],
  ],
  truncated: false,
};

const SCHEMA = {
  columns: ['table', 'kind', 'column'],
  rows: [['v_task', 'view', 'status']],
  truncated: false,
};

/** An index answering the schema statement and `SELECT status…`, and refusing anything else. */
const INDEX = fakeIndexPort({
  query: async (sql) => {
    if (sql.includes('sqlite_master')) return SCHEMA;
    if (sql.startsWith('SELECT status')) return COUNTS;
    throw new Error(`no such table: nowhere`);
  },
});

const NO_PANE: OpenEditors = {
  register: () => {},
  setPropertiesIfOpen: async () => false,
  savePane: () => {},
  reloadOthers: () => {},
};

/** `refuse`: what the disk says to every write, when it says no. */
function vault({ refuse = null }: { refuse?: string | null } = {}) {
  const files: Record<string, string> = { [DASHBOARD]: HOME };
  const created: { path: VaultPath; contents: string }[] = [];
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({ text: files[path] ?? '', modified: 1 }),
    writeTextFile: async ({ path, contents }) => {
      if (refuse !== null) throw new Error(refuse);
      files[path] = contents;
      return 2;
    },
    createNote: async (args) => {
      if (refuse !== null) throw new Error(refuse);
      created.push(args);
      return 0;
    },
  });
  return { fs, files, created };
}

// Held once, as the app holds them: a new list each render would re-run the DFAI query forever.
const NO_TYPES: readonly ObjectType[] = [];
const NO_NOTES: readonly string[] = [];

function queryPage(fs: ReturnType<typeof vault>['fs']) {
  const onSavedView = vi.fn();
  const onChanged = vi.fn();
  const activity = recordingActivity();
  const view = renderHook(() =>
    useQueryPage({
      ports: { index: INDEX, fs, markdown: remarkMarkdown, editors: NO_PANE, activity },
      open: true,
      indexKey: 'ready:1',
      viewPaths: VIEW_PATHS,
      dashboards: DASHBOARDS,
      onSavedView,
      onChanged,
      types: NO_TYPES,
      notePaths: NO_NOTES,
      onOpenNote: () => {},
    }),
  );
  return { view, onSavedView, onChanged, activity };
}

const VIEW_PATHS = ['.atlas/views/Tasks.md'];
const DASHBOARDS = [{ path: DASHBOARD, title: 'Home', icon: 'chart' as const }];

async function run(view: ReturnType<typeof queryPage>['view'], sql: string) {
  act(() => view.result.current.setSql(sql));
  act(() => view.result.current.run());
  await waitFor(() => expect(view.result.current.running).toBe(false));
}

describe('the query page', () => {
  it('reads the schema when it opens', async () => {
    const { view } = queryPage(vault().fs);
    await waitFor(() => expect(view.result.current.schema?.[0]?.name).toBe('v_task'));
  });

  it('runs a statement and offers only the layouts and shapes its columns allow', async () => {
    const { view } = queryPage(vault().fs);
    await run(view, 'SELECT status, n FROM counts;');
    expect(view.result.current.result?.rows).toHaveLength(2);
    expect(view.result.current.error).toBeNull();
    const list = view.result.current.layouts.find((choice) => choice.value === 'list');
    expect(list?.problem).toMatch(/path and title/);
    expect(view.result.current.shows.every((choice) => choice.problem === null)).toBe(true);
  });

  it('shows the index’s refusal and drops the last result', async () => {
    const { view } = queryPage(vault().fs);
    await run(view, 'SELECT status FROM counts');
    await run(view, 'SELECT * FROM nowhere');
    expect(view.result.current.error).toBe('no such table: nowhere');
    expect(view.result.current.result).toBeNull();
  });

  it('sorts the result by a clicked heading without running it again', async () => {
    const { view } = queryPage(vault().fs);
    await run(view, 'SELECT status, n FROM counts');
    act(() => view.result.current.toggleSort('n'));
    act(() => view.result.current.toggleSort('n'));
    expect(view.result.current.result?.rows.map((row) => row[1])).toEqual([6, 2]);
  });

  it('saves the statement that ran as a SQL view, and opens it', async () => {
    const { fs, created } = vault();
    const { view, onSavedView } = queryPage(fs);
    await run(view, 'SELECT status, n FROM counts');
    // Typed since the run: what was run is what is kept.
    act(() => view.result.current.setSql('SELECT half a thought'));
    act(() => view.result.current.saveAsView({ name: 'Counts', layout: 'table' }));
    await waitFor(() => expect(onSavedView).toHaveBeenCalledWith('.atlas/views/Counts.md'));
    expect(created[0]?.contents).toContain('sql: SELECT status, n FROM counts');
  });

  it('says why a view could not be saved', async () => {
    const { view } = queryPage(vault().fs);
    await run(view, 'SELECT status, n FROM counts');
    act(() => view.result.current.saveAsView({ name: 'tasks', layout: 'table' }));
    await waitFor(() => expect(view.result.current.saveError).toMatch(/already a view/));
  });

  it('adds the statement to a dashboard as a sql widget', async () => {
    const { fs, files } = vault();
    const { view, onChanged } = queryPage(fs);
    await run(view, 'SELECT status, n FROM counts');
    act(() =>
      view.result.current.addToDashboard({ path: DASHBOARD, show: 'bar', title: 'By status' }),
    );
    await waitFor(() =>
      expect(view.result.current.dashboardNotice).toBe('Added to the dashboard.'),
    );
    expect(files[DASHBOARD]).toContain('kind: sql');
    expect(files[DASHBOARD]).toContain('show: bar');
    expect(files[DASHBOARD]).toContain('sql: "SELECT status, n FROM counts"');
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('the query page and the Activity log', () => {
  it('records a SQL view that could not be written, once', async () => {
    const { view, activity } = queryPage(vault({ refuse: 'The disk is full.' }).fs);
    await run(view, 'SELECT status, n FROM counts');
    act(() => view.result.current.saveAsView({ name: 'Counts', layout: 'table' }));
    await waitFor(() => expect(view.result.current.saveError).toBe('The disk is full.'));
    expect(activity.reports).toEqual([
      {
        level: 'error',
        kind: 'save',
        message: 'Could not save the view. The disk is full.',
        subject: null,
      },
    ]);
  });

  it('records nothing for a SQL view saved, or one refused for its name', async () => {
    const { view, activity, onSavedView } = queryPage(vault().fs);
    await run(view, 'SELECT status, n FROM counts');
    act(() => view.result.current.saveAsView({ name: 'tasks', layout: 'table' }));
    await waitFor(() => expect(view.result.current.saveError).toMatch(/already a view/));
    act(() => view.result.current.saveAsView({ name: 'Counts', layout: 'table' }));
    await waitFor(() => expect(onSavedView).toHaveBeenCalled());
    expect(activity.reports).toEqual([]);
  });

  it('records a dashboard that could not take the statement, once, naming it', async () => {
    const { view, activity } = queryPage(vault({ refuse: 'The disk is full.' }).fs);
    await run(view, 'SELECT status, n FROM counts');
    act(() =>
      view.result.current.addToDashboard({ path: DASHBOARD, show: 'bar', title: 'By status' }),
    );
    await waitFor(() => expect(view.result.current.dashboardNotice).toBe('The disk is full.'));
    expect(activity.reports).toHaveLength(1);
    expect(activity.reports[0]).toMatchObject({
      level: 'error',
      message: 'Could not add the query to the dashboard — Home. The disk is full.',
      subject: { kind: 'note', path: DASHBOARD },
    });
  });

  it('records nothing for a statement added to a dashboard', async () => {
    const { view, activity } = queryPage(vault().fs);
    await run(view, 'SELECT status, n FROM counts');
    act(() =>
      view.result.current.addToDashboard({ path: DASHBOARD, show: 'bar', title: 'By status' }),
    );
    await waitFor(() =>
      expect(view.result.current.dashboardNotice).toBe('Added to the dashboard.'),
    );
    expect(activity.reports).toEqual([]);
  });
});

describe('a SQL view', () => {
  it('runs its statement and sorts what came back by a clicked heading', async () => {
    const path = createVaultPath('.atlas/views/Counts.md');
    const text = ['---', 'atlas: view', 'sql: SELECT status, n FROM counts', '---', ''].join('\n');
    const fs = fakeVaultFs({ readTextFile: async () => ({ text, modified: 1 }) });
    const note = await openNote({ fs, markdown: remarkMarkdown, path });
    const view = renderHook(() => useSqlView({ note, index: INDEX, indexKey: 'ready:1' }));

    await waitFor(() => expect(view.result.current.result?.rows).toHaveLength(2));
    expect(view.result.current.sql).toBe('SELECT status, n FROM counts');
    expect(view.result.current.layout).toBe('table');
    act(() => view.result.current.toggleSort('status'));
    expect(view.result.current.result?.rows.map((row) => row[0])).toEqual(['backlog', 'doing']);
  });

  it('shows why its statement could not run', async () => {
    const path = createVaultPath('.atlas/views/Broken.md');
    const text = ['---', 'atlas: view', 'sql: SELECT * FROM nowhere', '---', ''].join('\n');
    const fs = fakeVaultFs({ readTextFile: async () => ({ text, modified: 1 }) });
    const note = await openNote({ fs, markdown: remarkMarkdown, path });
    const view = renderHook(() => useSqlView({ note, index: INDEX, indexKey: 'ready:1' }));
    await waitFor(() => expect(view.result.current.error).toBe('no such table: nowhere'));
    expect(view.result.current.result).toBeNull();
  });
});
