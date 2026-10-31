// @vitest-environment jsdom
/**
 * P30-01: a board grouped by a relation to a project or an area has a column
 * for every note of both types — an area with nothing filed under it yet as
 * much as an empty project — so it asks the index for the notes of each.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, parseObjectType } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, openNote, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useSavedView } from './use-saved-view.ts';
import { useViewDrafts } from './use-view-drafts.ts';
import { createTickMemory } from './tick-memory.ts';

const VIEW_PATH = createVaultPath('.atlas/views/Projects.md');
const VIEW = [
  '---',
  'atlas: view',
  'type: task',
  'layout: board',
  'groupBy: project',
  'columns: [project]',
  '---',
  '',
].join('\n');
const TYPES = [
  parseObjectType({
    name: 'task',
    properties: { project: { kind: 'relation', target: ['project', 'area'] } },
  }),
];
const notesOfType = vi.fn(async () => []);
const INDEX = fakeIndexPort({ notesOfType });
const FS = fakeVaultFs({ readTextFile: async () => ({ text: VIEW, modified: 1 }) });
const EDITORS = {
  register: () => {},
  setPropertiesIfOpen: async () => false,
  savePane: () => {},
  reloadOthers: () => {},
};
const TICKS = createTickMemory();

describe('a board grouped by a relation to a project or an area', () => {
  it('asks for the notes of both types, to give each its column', async () => {
    const note = await openNote({ fs: FS, markdown: remarkMarkdown, path: VIEW_PATH });
    renderHook(() =>
      useSavedView({
        note,
        index: INDEX,
        fs: FS,
        markdown: remarkMarkdown,
        types: TYPES,
        notePaths: [],
        indexKey: 'ready:1',
        onChanged: () => {},
        editors: EDITORS,
        tickMemory: TICKS,
        drafts: useViewDrafts('/vault'),
        viewPaths: [VIEW_PATH],
        activity: recordingActivity(),
      }),
    );
    await waitFor(() => expect(notesOfType).toHaveBeenCalledWith('area'));
    expect(notesOfType).toHaveBeenCalledWith('project');
  });
});
