// @vitest-environment jsdom
/**
 * #928: which rows the properties panel edits as a due with an optional time
 * of day: a task's `due`, where it is a date. Another date of a task, a due
 * of another kind, or a due on a note that is not a task, is edited as its kind.
 */
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createVaultPath, parseObjectType, type ObjectType, type VaultPath } from '@dfai/domain';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs, type OpenNote } from '@dfai/application';
import { useNoteProperties } from './use-note-properties.ts';

const links = { fs: fakeVaultFs(), markdown: fakeMarkdown(), notePaths: [] as VaultPath[] };
const index = fakeIndexPort();

function editorOf(types: readonly ObjectType[], properties: Record<string, unknown>, key: string) {
  const open = { path: createVaultPath('Tasks/Call.md'), properties } as unknown as OpenNote;
  const { result, unmount } = renderHook(() =>
    useNoteProperties({ note: open, types, index, links }),
  );
  const row = result.current.rows.find((each) => each.def.key === key);
  unmount();
  return row === undefined ? 'no row' : row.editor;
}

const TASK = parseObjectType({ name: 'task', properties: { due: 'date', defer: 'date' } });

describe('useNoteProperties: a task’s due row (#928)', () => {
  it('takes a time where the Task type declares due a date, timed or not', () => {
    expect(editorOf([TASK], { type: 'task', due: '2026-12-04' }, 'due')).toBe('dueTime');
    expect(editorOf([TASK], { type: 'Task', due: '2026-12-04T15:30' }, 'due')).toBe('dueTime');
  });

  it('takes none on another date of a task', () => {
    expect(editorOf([TASK], { type: 'task', defer: '2026-12-04' }, 'defer')).toBeUndefined();
  });

  it('takes none where the Task type keeps due as another kind', () => {
    const own = parseObjectType({ name: 'task', properties: { due: 'text' } });
    expect(editorOf([own], { type: 'task', due: 'Friday' }, 'due')).toBeUndefined();
  });

  it('takes none on a note that is not a task', () => {
    const invoice = parseObjectType({ name: 'invoice', properties: { due: 'date' } });
    expect(editorOf([invoice], { type: 'invoice', due: '2026-12-04' }, 'due')).toBeUndefined();
  });
});
