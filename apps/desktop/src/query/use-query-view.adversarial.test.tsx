// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, parseObjectType, type ObjectType } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, openNote, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { useQueryView } from './use-query-view.ts';

/** Where the hooks under test record what they give up on; these tests do not read it. */
const ACTIVITY = recordingActivity();

/** Nothing folded, and folding remembered nowhere: these tests are about the query. */
const NO_FOLDS = { collapsed: new Set<string>(), onToggle: () => {} };
const NO_QUERY_FOLD = { store: { read: () => null, write: () => {} }, view: 'v\u0000Open work.md' };

/**
 * Adversarial (P24-04, ADR-0019): saving a query view writes its query and
 * layout through the byte-preserving write, and must never lose the view.
 */

const PATH = createVaultPath('.atlas/views/Open work.md');

const view = (layoutLine: string) =>
  [
    '---',
    'atlas: view',
    layoutLine,
    'query: FROM task GROUP BY status',
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
const NONE = [] as const;
const NO_PANE: OpenEditors = {
  register: () => {},
  setPropertiesIfOpen: async () => false,
  savePane: () => {},
  reloadOthers: () => {},
};

async function opened(text: string) {
  const files: Record<string, string> = { [PATH]: text };
  const fs = fakeVaultFs({
    readTextFile: async (path) => ({ text: files[path] ?? '', modified: 1 }),
    writeTextFile: async ({ path, contents }) => {
      files[path] = contents;
      return 2;
    },
  });
  const note = await openNote({ fs, markdown: remarkMarkdown, path: PATH });
  const onChanged = vi.fn();
  const index = fakeIndexPort({
    query: async () => ({
      columns: ['path', 'title', 'type', 'status'],
      rows: [],
      truncated: false,
    }),
  });
  const hook = renderHook(() =>
    useQueryView({
      note,
      ports: { index, fs, markdown: remarkMarkdown, editors: NO_PANE, activity: ACTIVITY },
      folds: NO_FOLDS,
      queryFold: NO_QUERY_FOLD,
      types: TYPES,
      notePaths: NONE,
      indexKey: 'ready:1',
      queryViews: NONE,
      dashboards: NONE,
      viewPaths: NONE,
      onChanged,
      onOpenNote: () => {},
      clock: { today: () => '2026-10-28' },
    }),
  );
  await waitFor(() => expect(hook.result.current).not.toBeNull());
  return { hook, files, onChanged };
}

describe('saving a query view (adversarial)', () => {
  it('leaves the layout line as written when only the query changed', async () => {
    // Why: save() always writes { query, layout }; the unchanged layout is still
    // "touched", so its line is re-serialised and loses the spacing before its comment.
    const layoutLine = 'layout: board   # drawn as columns';
    const { hook, files, onChanged } = await opened(view(layoutLine));
    act(() =>
      hook.result.current?.panel.composer.onTextChange('FROM task GROUP BY status THEN title'),
    );
    act(() => hook.result.current?.save());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(files[PATH]).toContain(`\n${layoutLine}\n`);
  });

  it('does not turn a query view into an ordinary note when its text is cleared and saved', async () => {
    // Why: Save is offered whenever the text differs from the file; saving ''
    // writes query: '' — parseQueryView then answers null, and the view silently
    // stops being one (its query gone from the file).
    const { hook, files } = await opened(view('layout: board'));
    act(() => hook.result.current?.panel.composer.onTextChange(''));
    act(() => hook.result.current?.save());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(files[PATH]).toContain('query: FROM task GROUP BY status');
  });

  it('does not save a blank query as a new view either, and says why', async () => {
    const { hook } = await opened(view('layout: board'));
    act(() => hook.result.current?.panel.composer.onTextChange(''));
    act(() => hook.result.current?.saveAs('Nothing'));
    await waitFor(() =>
      expect(hook.result.current?.saveError).toBe('Write a query before saving: FROM task.'),
    );
  });
});
