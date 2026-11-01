// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, parseObjectType, type ObjectType } from '@dfai/domain';
import {
  fakeIndexPort,
  fakeVaultFs,
  openNote,
  type OpenNote,
  recordingActivity,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { QueryPanelFoldStore } from '@dfai/ui';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useQueryView } from './use-query-view.ts';

/** Nothing folded, and folding remembered nowhere: these tests are about the query. */
const NO_FOLDS = { collapsed: new Set<string>(), onToggle: () => {} };

/** The query fold remembered in a map, as localStorage would hold it. */
function queryFoldStore() {
  const held = new Map<string, boolean>();
  const store: QueryPanelFoldStore = {
    read: (view) => held.get(view) ?? null,
    write: (view, collapsed) => {
      held.set(view, collapsed);
    },
  };
  return { store, held };
}

/**
 * P24-04: a saved DFAI query, opened as a page. Its query is edited in the
 * builder or as text; Save writes `query` and `layout` and leaves every other
 * byte of the file as it was written.
 */

const PATH = createVaultPath('.atlas/views/Open work.md');

const VIEW = [
  '---',
  'atlas: view',
  'layout: board',
  '# kept exactly as it is',
  'query: FROM task GROUP BY status',
  'icon: board',
  '---',
  '',
  '# Open work',
  '',
].join('\n');

const TYPES: readonly ObjectType[] = [
  parseObjectType({
    name: 'task',
    properties: { status: { kind: 'select', options: ['doing', 'done'] } },
  }),
];
const NOTES: readonly string[] = ['tasks/A.md', 'tasks/B.md'];
const NO_VIEWS = [] as const;
const NO_DASHBOARDS = [] as const;
const NO_PANE: OpenEditors = {
  register: () => {},
  setPropertiesIfOpen: async () => false,
  savePane: () => {},
  reloadOthers: () => {},
};

/** An index that answers every DFAI query with two tasks, and records what it was asked. */
function taskIndex() {
  const asked: string[] = [];
  const index = fakeIndexPort({
    query: async (sql) => {
      asked.push(sql);
      return {
        columns: ['path', 'title', 'type', 'status'],
        rows: [
          ['tasks/A.md', 'A', 'task', 'doing'],
          ['tasks/B.md', 'B', 'task', 'done'],
        ],
        truncated: false,
      };
    },
  });
  return { index, asked };
}

async function opened() {
  const files: Record<string, string> = { [PATH]: VIEW };
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({ text: files[path] ?? '', modified: 1 }),
    writeTextFile: async ({ path, contents }) => {
      files[path] = contents;
      return 2;
    },
  });
  const note = await openNote({ fs, markdown: remarkMarkdown, path: PATH });
  return { fs, files, note };
}

function render(note: OpenNote | null, fs: ReturnType<typeof fakeVaultFs>) {
  const { index, asked } = taskIndex();
  const onChanged = vi.fn();
  const activity = recordingActivity();
  const folds = queryFoldStore();
  const view = renderHook(() =>
    useQueryView({
      note,
      ports: { index, fs, markdown: remarkMarkdown, editors: NO_PANE, activity },
      folds: NO_FOLDS,
      queryFold: { store: folds.store, view: 'v\u0000Open work.md' },
      types: TYPES,
      notePaths: NOTES,
      indexKey: 'ready:1',
      indexKeyNow: () => 'ready:1',
      queryViews: NO_VIEWS,
      dashboards: NO_DASHBOARDS,
      viewPaths: NO_VIEWS,
      onChanged,
      onOpenNote: () => {},
      clock: { today: () => '2026-10-28' },
    }),
  );
  return { view, asked, onChanged, activity, held: folds.held };
}

describe('useQueryView', () => {
  it('is nothing for a note that is not a saved query, and asks the index nothing', async () => {
    const { fs } = await opened();
    const { view, asked } = render(null, fs);
    expect(view.result.current).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toEqual([]);
  });

  it('runs the saved query and draws it in its layout, grouped, in the builder', async () => {
    const { fs, note } = await opened();
    const { view } = render(note, fs);
    await waitFor(() => expect(view.result.current?.panel.result?.rows).toHaveLength(2));
    const state = view.result.current;
    expect(state?.panel.layout).toBe('board');
    expect(state?.panel.composer.mode).toBe('builder');
    expect(state?.panel.result?.groups.map((group) => [group.label, group.rows.length])).toEqual([
      ['doing', 1],
      ['done', 1],
    ]);
    expect(state?.tabs.map((tab) => [tab.title, tab.selected])).toEqual([['Open work', true]]);
    expect(state?.edited).toBe(false);
  });

  it('opens a saved query folded to its one line, and remembers it opened', async () => {
    const { fs, note } = await opened();
    const { view, held } = render(note, fs);
    await waitFor(() => expect(view.result.current?.panel.result?.rows).toHaveLength(2));
    expect(view.result.current?.panel.fold?.collapsed).toBe(true);
    act(() => view.result.current?.panel.fold?.onToggle());
    expect(view.result.current?.panel.fold?.collapsed).toBe(false);
    expect(held.get('v\u0000Open work.md')).toBe(false);
  });

  it('saves the query and the layout, leaving every other line as it was written', async () => {
    const { fs, files, note } = await opened();
    const { view, onChanged } = render(note, fs);
    await waitFor(() => expect(view.result.current).not.toBeNull());
    act(() =>
      view.result.current?.panel.composer.onTextChange('FROM task  GROUP BY status  THEN title'),
    );
    act(() => view.result.current?.panel.onLayout('list'));
    expect(view.result.current?.edited).toBe(true);
    act(() => view.result.current?.save());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(files[PATH]).toBe(
      VIEW.replace('layout: board', 'layout: list').replace(
        'query: FROM task GROUP BY status',
        'query: FROM task  GROUP BY status  THEN title',
      ),
    );
  });

  it('records a save it gives up on once, naming the view, and nothing for one that lands', async () => {
    const { files, note } = await opened();
    const refusing = fakeVaultFs({
      readTextFile: async (path) => ({ text: files[path] ?? '', modified: 1 }),
      writeTextFile: async () => {
        throw new Error('The disk is full.');
      },
    });
    const refused = render(note, refusing);
    await waitFor(() => expect(refused.view.result.current).not.toBeNull());
    act(() => refused.view.result.current?.panel.onLayout('list'));
    act(() => refused.view.result.current?.save());
    await waitFor(() => expect(refused.view.result.current?.saveError).toBe('The disk is full.'));
    expect(refused.activity.reports).toEqual([
      {
        level: 'error',
        kind: 'save',
        message: 'Could not save an edit — Open work. The disk is full.',
        subject: { kind: 'note', path: PATH },
      },
    ]);

    const { fs } = await opened();
    const saved = render(note, fs);
    await waitFor(() => expect(saved.view.result.current).not.toBeNull());
    act(() => saved.view.result.current?.panel.onLayout('list'));
    act(() => saved.view.result.current?.save());
    await waitFor(() => expect(saved.onChanged).toHaveBeenCalled());
    expect(saved.activity.reports).toEqual([]);
  });

  it('stays in the text after a save reloads the note, and keeps what was typed since', async () => {
    const { fs, files, note } = await opened();
    const { index } = taskIndex();
    let current = note;
    const view = renderHook(() =>
      useQueryView({
        note: current,
        ports: {
          index,
          fs,
          markdown: remarkMarkdown,
          editors: NO_PANE,
          activity: recordingActivity(),
        },
        folds: NO_FOLDS,
        queryFold: { store: queryFoldStore().store, view: 'v\u0000Open work.md' },
        types: TYPES,
        notePaths: NOTES,
        indexKey: 'ready:1',
        indexKeyNow: () => 'ready:1',
        queryViews: NO_VIEWS,
        dashboards: NO_DASHBOARDS,
        viewPaths: NO_VIEWS,
        onChanged: () => {},
        onOpenNote: () => {},
        clock: { today: () => '2026-10-28' },
      }),
    );
    act(() => view.result.current?.panel.composer.onMode('text'));
    act(() => view.result.current?.panel.composer.onTextChange('FROM task SORT BY title'));
    act(() => view.result.current?.save());
    await waitFor(() => expect(files[PATH]).toContain('query: FROM task SORT BY title'));
    // The file comes back as it was written; the page reopens it.
    current = await openNote({ fs, markdown: remarkMarkdown, path: PATH });
    view.rerender();
    expect(view.result.current?.panel.composer.mode).toBe('text');
    expect(view.result.current?.edited).toBe(false);
  });

  it('puts the query and layout back as the file has them on Reset', async () => {
    const { fs, note } = await opened();
    const { view } = render(note, fs);
    await waitFor(() => expect(view.result.current).not.toBeNull());
    act(() => view.result.current?.panel.composer.onTextChange('FROM task WHERE ('));
    act(() => view.result.current?.panel.onLayout('table'));
    act(() => view.result.current?.reset());
    expect(view.result.current?.panel.composer.text).toBe('FROM task GROUP BY status');
    expect(view.result.current?.panel.layout).toBe('board');
    expect(view.result.current?.edited).toBe(false);
  });

  it('points at a problem in the text and keeps the last answer while it is fixed', async () => {
    const { fs, note } = await opened();
    const { view } = render(note, fs);
    await waitFor(() => expect(view.result.current?.panel.result?.rows).toHaveLength(2));
    act(() => view.result.current?.panel.composer.onTextChange('FROM task WHERE stauts = x'));
    await waitFor(() =>
      expect(view.result.current?.panel.composer.problem?.message).toBe(
        'A task has no field called stauts.',
      ),
    );
    expect(view.result.current?.panel.result?.rows).toHaveLength(2);
  });

  it('keeps a query the builder cannot show as text, and says why', async () => {
    const { fs, note } = await opened();
    const { view } = render(note, fs);
    await waitFor(() => expect(view.result.current).not.toBeNull());
    act(() =>
      view.result.current?.panel.composer.onTextChange(
        'FROM task WHERE status = doing AND (status = done OR title = A)',
      ),
    );
    act(() => view.result.current?.panel.composer.onMode('builder'));
    expect(view.result.current?.panel.composer.mode).toBe('text');
    expect(view.result.current?.panel.composer.textOnly).toMatch(/cannot show/);
  });

  it('opens the builder on text it can show, and writes the builder’s edits back as text', async () => {
    const { fs, note } = await opened();
    const { view } = render(note, fs);
    await waitFor(() => expect(view.result.current).not.toBeNull());
    act(() => view.result.current?.panel.composer.onMode('text'));
    act(() => view.result.current?.panel.composer.onTextChange('from task where status = done'));
    act(() => view.result.current?.panel.composer.onMode('builder'));
    const builder = view.result.current?.panel.composer.builder;
    expect(builder?.conditions).toHaveLength(1);
    if (builder === null || builder === undefined) throw new Error('no builder');
    act(() =>
      view.result.current?.panel.composer.onBuilderChange({
        ...builder,
        match: 'any',
        group: ['status'],
      }),
    );
    expect(view.result.current?.panel.composer.text).toBe(
      'FROM task WHERE status = done GROUP BY status',
    );
  });
});
