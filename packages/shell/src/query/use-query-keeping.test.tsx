// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, type VaultPath } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useQueryKeeping } from './use-query-keeping.ts';

const DASHBOARD = createVaultPath('.atlas/dashboards/Home.md');
const HOME = ['---', 'atlas: dashboard', 'widgets: []', '---', '', '# Home', ''].join('\n');
const TEXT = 'FROM task  WHERE status != done GROUP BY status';
const NO_PANE: OpenEditors = {
  register: () => {},
  setPropertiesIfOpen: async () => false,
  savePane: () => {},
  reloadOthers: () => {},
};
const VIEWS = ['.atlas/views/Open.md'];
const DASHBOARDS = [{ path: DASHBOARD, title: 'Home', icon: 'chart' as const }];

/** `refuse`: what the disk says to every write, when it says no. */
function keeping({ refuse = null }: { refuse?: string | null } = {}) {
  const files: Record<string, string> = { [DASHBOARD]: HOME };
  const created: { path: VaultPath; contents: string }[] = [];
  const activity = recordingActivity();
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
  const onSavedView = vi.fn();
  const onChanged = vi.fn();
  const view = renderHook(() =>
    useQueryKeeping({
      ports: {
        index: fakeIndexPort(),
        fs,
        markdown: remarkMarkdown,
        editors: NO_PANE,
        activity,
      },
      text: TEXT,
      viewPaths: VIEWS,
      dashboards: DASHBOARDS,
      onSavedView,
      onChanged,
    }),
  );
  return { view, files, created, onSavedView, onChanged, activity };
}

describe('useQueryKeeping', () => {
  it('saves the query as a view note, as written, and opens it', async () => {
    const { view, created, onSavedView } = keeping();
    act(() => view.result.current.save.onSave({ name: 'Work', layout: 'board' }));
    await waitFor(() => expect(onSavedView).toHaveBeenCalledWith('.atlas/views/Work.md'));
    expect(created[0]?.contents).toContain('atlas: view');
    expect(created[0]?.contents).toContain('layout: board');
    expect(created[0]?.contents).toContain(`query: ${TEXT}`);
    expect(view.result.current.save.layouts.map((choice) => choice.value)).toEqual([
      'table',
      'board',
      'list',
    ]);
  });

  it('says why a view could not be saved', async () => {
    const { view } = keeping();
    act(() => view.result.current.save.onSave({ name: 'open', layout: 'table' }));
    await waitFor(() => expect(view.result.current.save.error).toMatch(/already a view/));
  });

  it('adds the query to a dashboard as a query widget', async () => {
    const { view, files, onChanged } = keeping();
    expect(view.result.current.dashboards.choices).toEqual([{ value: DASHBOARD, label: 'Home' }]);
    act(() => view.result.current.dashboards.onAdd({ path: DASHBOARD, title: 'Open' }));
    await waitFor(() =>
      expect(view.result.current.dashboards.notice).toBe('Added to the dashboard.'),
    );
    expect(files[DASHBOARD]).toContain('kind: query');
    expect(files[DASHBOARD]).toContain(`query: ${TEXT}`);
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('useQueryKeeping and the Activity log', () => {
  it('records a view that could not be written, once', async () => {
    const { view, activity } = keeping({ refuse: 'The disk is full.' });
    act(() => view.result.current.save.onSave({ name: 'Work', layout: 'board' }));
    await waitFor(() => expect(view.result.current.save.error).toBe('The disk is full.'));
    expect(activity.reports).toEqual([
      {
        level: 'error',
        kind: 'save',
        message: 'Could not save the view. The disk is full.',
        subject: null,
      },
    ]);
  });

  it('records nothing for a view saved, or one refused for its name', async () => {
    const { view, activity, onSavedView } = keeping();
    act(() => view.result.current.save.onSave({ name: 'open', layout: 'table' }));
    await waitFor(() => expect(view.result.current.save.error).toMatch(/already a view/));
    act(() => view.result.current.save.onSave({ name: 'Work', layout: 'board' }));
    await waitFor(() => expect(onSavedView).toHaveBeenCalled());
    expect(activity.reports).toEqual([]);
  });

  it('records a dashboard that could not take the query, once, naming it', async () => {
    const { view, activity } = keeping({ refuse: 'The disk is full.' });
    act(() => view.result.current.dashboards.onAdd({ path: DASHBOARD, title: 'Open' }));
    await waitFor(() => expect(view.result.current.dashboards.notice).toBe('The disk is full.'));
    expect(activity.reports).toEqual([
      {
        level: 'error',
        kind: 'save',
        message: 'Could not add the query to the dashboard — Home. The disk is full.',
        subject: { kind: 'note', path: DASHBOARD },
      },
    ]);
  });

  it('records nothing for a query added to a dashboard', async () => {
    const { view, activity } = keeping();
    act(() => view.result.current.dashboards.onAdd({ path: DASHBOARD, title: 'Open' }));
    await waitFor(() =>
      expect(view.result.current.dashboards.notice).toBe('Added to the dashboard.'),
    );
    expect(activity.reports).toEqual([]);
  });
});
