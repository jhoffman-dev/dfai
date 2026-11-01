// @vitest-environment jsdom
/**
 * A relation that links a note of a type it does not point at shows why, on
 * its row (P30-01) — read from the linked note's own file.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, parseObjectType, type VaultPath } from '@dfai/domain';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs, type OpenNote } from '@dfai/application';
import { useNoteProperties } from './use-note-properties.ts';

const FILES: Record<string, string> = {
  'Projects/DFAI.md': '---\ntype: project\n---\n',
  'People/Mara Quill.md': '---\ntype: person\n---\n',
};
const TYPES = [
  parseObjectType({
    name: 'task',
    properties: { project: { kind: 'relation', target: ['project', 'area'] } },
  }),
];
const index = fakeIndexPort();
const readNotes = vi.fn(async (paths: readonly string[]) =>
  paths.flatMap((path) => {
    const text = FILES[path];
    return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
  }),
);
const links = {
  fs: fakeVaultFs({ readNotes }),
  markdown: fakeMarkdown(),
  notePaths: [...Object.keys(FILES), 'Tasks/Call.md'].map(createVaultPath) as VaultPath[],
};
const note = (project: string): OpenNote =>
  ({
    path: createVaultPath('Tasks/Call.md'),
    properties: { type: 'task', project },
  }) as unknown as OpenNote;

const errorOf = (rows: readonly { def: { key: string }; error: string | null }[]) =>
  rows.find((row) => row.def.key === 'project')?.error ?? null;

describe('useNoteProperties: a relation linking the wrong kind of note', () => {
  const wrong = note('[[Mara Quill]]');
  const right = note('[[DFAI]]');

  it('says the relation does not take a person', async () => {
    const { result } = renderHook(() =>
      useNoteProperties({ note: wrong, types: TYPES, index, links }),
    );
    await waitFor(() =>
      expect(errorOf(result.current.rows)).toBe('Project links to a project or area, not a person'),
    );
  });

  it('has nothing to say about a project', async () => {
    const { result } = renderHook(() =>
      useNoteProperties({ note: right, types: TYPES, index, links }),
    );
    // Once the linked note has been read and judged, there is still nothing to say.
    await waitFor(() => expect(readNotes).toHaveBeenCalledWith(['Projects/DFAI.md']));
    await act(async () => {});
    expect(errorOf(result.current.rows)).toBeNull();
  });
});
