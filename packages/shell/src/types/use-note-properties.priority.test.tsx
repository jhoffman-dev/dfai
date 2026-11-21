// @vitest-environment jsdom
/**
 * #913: which `priority` rows the properties panel edits as a task's 1 to 4
 * (None, P1 to P4): a task's, in a vault whose Task type ranks its tasks
 * (`ranksTasks`), whether the type declares it or the note just holds it.
 * A goal's own `priority`, or one a Task type keeps as another kind, is
 * edited as its kind.
 */
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createVaultPath, parseObjectType, type ObjectType, type VaultPath } from '@dfai/domain';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs, type OpenNote } from '@dfai/application';
import { useNoteProperties } from './use-note-properties.ts';

const links = {
  fs: fakeVaultFs(),
  markdown: fakeMarkdown(),
  notePaths: [] as VaultPath[],
};
const note = (properties: Record<string, unknown>): OpenNote =>
  ({ path: createVaultPath('Tasks/Call.md'), properties }) as unknown as OpenNote;

const index = fakeIndexPort();

function editorOf(types: readonly ObjectType[], properties: Record<string, unknown>) {
  // Made once, not on every render: a new note each render would read it again without end.
  const open = note(properties);
  const { result, unmount } = renderHook(() =>
    useNoteProperties({ note: open, types, index, links }),
  );
  const editor = result.current.rows.find((row) => row.def.key === 'priority')?.editor;
  unmount();
  return editor;
}

const task = (priority: unknown) =>
  parseObjectType({ name: 'task', properties: priority === undefined ? {} : { priority } });

describe('useNoteProperties: a task’s priority row', () => {
  it('is picked as None or P1 to P4 where the Task type declares it a number', () => {
    expect(editorOf([task('number')], { type: 'task', priority: 2 })).toBe('priority');
  });

  it('is picked so too where the note holds it undeclared, a value of its own included', () => {
    expect(editorOf([task(undefined)], { type: 'task', priority: 7 })).toBe('priority');
    expect(editorOf([], { type: 'Task', priority: 'high' })).toBe('priority');
  });

  it('is edited as its kind where the Task type keeps a priority of another kind', () => {
    const own = task({ kind: 'select', options: ['High', 'Low'] });
    expect(editorOf([own], { type: 'task', priority: 'High' })).toBeUndefined();
  });

  it('is edited as its kind on a note that is not a task', () => {
    const goal = parseObjectType({ name: 'goal', properties: { priority: 'number' } });
    expect(editorOf([goal], { type: 'goal', priority: 7 })).toBeUndefined();
  });
});
