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
import { TYPES_NOT_READ } from './use-types.ts';

const links = {
  fs: fakeVaultFs(),
  markdown: fakeMarkdown(),
  notePaths: [] as VaultPath[],
};
const note = (properties: Record<string, unknown>): OpenNote =>
  ({ path: createVaultPath('Tasks/Call.md'), properties }) as unknown as OpenNote;

const index = fakeIndexPort();

function rowsOf(types: readonly ObjectType[], properties: Record<string, unknown>) {
  // Made once, not on every render: a new note each render would read it again without end.
  const open = note(properties);
  const { result, unmount } = renderHook(() =>
    useNoteProperties({ note: open, types, index, links }),
  );
  const rows = result.current.rows;
  unmount();
  return rows;
}

const rowOf = (types: readonly ObjectType[], properties: Record<string, unknown>, key: string) =>
  rowsOf(types, properties).find((row) => row.def.key === key);

const editorOf = (types: readonly ObjectType[], properties: Record<string, unknown>) =>
  rowOf(types, properties, 'priority')?.editor;

const task = (priority: unknown) =>
  parseObjectType({ name: 'task', properties: priority === undefined ? {} : { priority } });

describe('useNoteProperties: a task’s priority row', () => {
  it('is picked as None or P1 to P4 where the Task type declares it a number', () => {
    expect(editorOf([task('number')], { type: 'task', priority: 2 })).toBe('priority');
  });

  it('is picked so too where the note holds it undeclared, a value of its own included', () => {
    expect(editorOf([task(undefined)], { type: 'task', priority: 7 })).toBe('priority');
    expect(editorOf([task(undefined)], { type: 'Task', priority: 'high' })).toBe('priority');
  });

  it('is edited as its kind while the vault’s types are not read: its Task type may keep its own', () => {
    expect(editorOf(TYPES_NOT_READ, { type: 'task', priority: 'High' })).toBeUndefined();
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

describe('useNoteProperties: a task’s priority row is never called invalid (#917 review)', () => {
  const NUMBERED = parseObjectType({
    name: 'task',
    properties: { priority: 'number', estimate: 'number' },
  });

  it('picks a value of the note’s own, with no alert: a soft field allows it', () => {
    for (const priority of ['high', 7, '2', [1, 2], 3]) {
      const row = rowOf([NUMBERED], { type: 'task', priority }, 'priority');
      expect(row?.editor).toBe('priority');
      expect(row?.error).toBeNull();
    }
  });

  it('still calls an ordinary number property on the same note invalid when it holds words', () => {
    const row = rowOf([NUMBERED], { type: 'task', priority: 'high', estimate: 'soon' }, 'estimate');
    expect(row?.editor).toBeUndefined();
    expect(row?.error).not.toBeNull();
  });
});
