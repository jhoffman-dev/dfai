// @vitest-environment jsdom
/**
 * Adversarial pass on Phase 23 (A23): "Include archived" is a choice made on
 * one view. A pane that goes from one view to another is the same hook with a
 * new note, so what was chosen on the first must not carry to the second —
 * the way the rows chosen for archiving do not (`useViewChoosing`, by key).
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, type ObjectType } from '@dfai/domain';
import {
  fakeIndexPort,
  fakeVaultFs,
  openNote,
  type OpenNote,
  recordingActivity,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useSavedView } from './use-saved-view.ts';
import { useViewDrafts } from './use-view-drafts.ts';
import type { OpenEditors } from '../panes/open-editors.ts';
import { createTickMemory } from './tick-memory.ts';

/** Where the hooks under test record what they give up on; these tests do not read it. */
const ACTIVITY = recordingActivity();

const view = (title: string) =>
  ['---', 'atlas: view', 'type: task', 'layout: table', '---', '', `# ${title}`, ''].join('\n');

const FILES: Record<string, string> = {
  '.atlas/views/Open.md': view('Open'),
  '.atlas/views/Done.md': view('Done'),
};

const TYPES: readonly ObjectType[] = [{ name: 'task', label: 'Task', properties: [] }];

const fs = fakeVaultFs({
  readTextFile: async (path) => ({ text: FILES[path] ?? '', modified: 1 }),
});
const INDEX = fakeIndexPort();
const EDITORS: OpenEditors = {
  register: () => {},
  setPropertiesIfOpen: async () => false,
  savePane: () => {},
  reloadOthers: () => {},
};
const TICKS = createTickMemory();
const VIEW_PATHS = Object.keys(FILES).map((path) => createVaultPath(path));

const open = (path: string) =>
  openNote({ fs, markdown: remarkMarkdown, path: createVaultPath(path) });

describe('Include archived belongs to the view it was turned on in (A23)', () => {
  it('is off again when the pane goes on to another view', async () => {
    const first = await open('.atlas/views/Open.md');
    const second = await open('.atlas/views/Done.md');
    const hook = renderHook(
      ({ note }: { note: OpenNote }) =>
        useSavedView({
          activity: ACTIVITY,
          note,
          index: INDEX,
          fs,
          markdown: remarkMarkdown,
          types: TYPES,
          notePaths: [],
          indexKey: 'ready:1',
          onChanged: () => {},
          editors: EDITORS,
          tickMemory: TICKS,
          drafts: useViewDrafts('/vault'),
          viewPaths: VIEW_PATHS,
        }),
      { initialProps: { note: first } },
    );
    await waitFor(() => expect(hook.result.current.query).not.toBeNull());

    act(() => hook.result.current.setIncludeArchived(true));
    expect(hook.result.current.includeArchived).toBe(true);

    hook.rerender({ note: second });
    await waitFor(() => expect(hook.result.current.query).not.toBeNull());
    expect(hook.result.current.includeArchived).toBe(false);
  });
});
