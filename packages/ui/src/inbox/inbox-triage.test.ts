import { describe, expect, it } from 'vitest';
import { createVaultPath, type InboxItem, type InboxTask } from '@dfai/domain';
import {
  asksWhoItWaitsOn,
  clarificationOf,
  linkFieldsShown,
  refusalStands,
  rowAfter,
  rowAfterLeaving,
  typedInShown,
  unpickedLink,
  unpickedRefusal,
  withTyped,
} from './inbox-triage.ts';

const TASK: InboxTask = {
  status: 'inbox',
  project: createVaultPath('Projects/DFAI.md'),
  waitingOn: null,
  waitingOnNames: '',
  defer: '2026-10-20',
  due: null,
};

describe('clarificationOf', () => {
  it('is null while the row holds nothing, or only what the task already says', () => {
    expect(clarificationOf(TASK, {})).toBeNull();
    expect(
      clarificationOf(TASK, {
        status: 'inbox',
        project: createVaultPath('Projects/DFAI.md'),
        defer: '2026-10-20',
        due: '',
      }),
    ).toBeNull();
  });

  it('names only what differs from the task', () => {
    expect(
      clarificationOf(TASK, {
        status: 'waiting',
        project: createVaultPath('Projects/DFAI.md'),
        waitingOn: createVaultPath('People/Mara Quill.md'),
      }),
    ).toEqual({ status: 'waiting', waitingOn: 'People/Mara Quill.md' });
  });

  it('clears a date the task had and the row emptied, and sets one it changed', () => {
    expect(clarificationOf(TASK, { defer: '', due: '2026-11-02' })).toEqual({
      defer: null,
      due: '2026-11-02',
    });
  });
});

describe('asksWhoItWaitsOn', () => {
  it('is whether the task is Waiting, or the row is making it so', () => {
    expect(asksWhoItWaitsOn(TASK, {})).toBe(false);
    expect(asksWhoItWaitsOn(TASK, { status: 'waiting' })).toBe(true);
    expect(asksWhoItWaitsOn({ ...TASK, status: 'waiting' }, {})).toBe(true);
    expect(asksWhoItWaitsOn({ ...TASK, status: 'waiting' }, { status: 'backlog' })).toBe(false);
  });
});

describe('rowAfter', () => {
  const items = ['Inbox/A.md', 'Inbox/B.md', 'Inbox/C.md'].map(
    (path) => ({ path: createVaultPath(path) }) as InboxItem,
  );
  const after = (path: string) => rowAfter(items, createVaultPath(path));

  it('is the row below, or the one above the last', () => {
    expect(after('Inbox/A.md')).toBe('Inbox/B.md');
    expect(after('Inbox/C.md')).toBe('Inbox/B.md');
  });

  it('is nothing after the only row, and the first row for one not listed', () => {
    expect(rowAfter(items.slice(0, 1), createVaultPath('Inbox/A.md'))).toBeNull();
    expect(after('Inbox/Gone.md')).toBe('Inbox/A.md');
  });
});

describe('rowAfterLeaving', () => {
  const listOf = (...names: string[]) =>
    names.map((name) => ({ path: createVaultPath(`Inbox/${name}.md`) }) as InboxItem);
  const before = listOf('A', 'B', 'C', 'D');
  const left = (after: InboxItem[], name: string) =>
    rowAfterLeaving(before, after, createVaultPath(`Inbox/${name}.md`));

  it('is the next row still listed, skipping one that left with it', () => {
    expect(left(listOf('B', 'C', 'D'), 'A')).toBe('Inbox/B.md');
    expect(left(listOf('C', 'D'), 'A')).toBe('Inbox/C.md');
  });

  it('is the row above when none below is still listed, and nothing when none is', () => {
    expect(left(listOf('A', 'B'), 'C')).toBe('Inbox/B.md');
    expect(left([], 'B')).toBeNull();
    expect(left(listOf('A', 'B'), 'Gone')).toBeNull();
  });
});

describe('a link typed and not picked (#823)', () => {
  it('holds what each field has typed, and lets go of a field told nothing is', () => {
    const typed = withTyped(withTyped(undefined, 'project', 'Zeph'), 'waitingOn', 'Mar');
    expect(typed).toEqual({ project: 'Zeph', waitingOn: 'Mar' });
    expect(withTyped(typed, 'waitingOn', null)).toEqual({ project: 'Zeph' });
    expect(withTyped(undefined, 'project', null)).toEqual({});
  });

  it('names who it waits on before the project, and nothing when neither is typed', () => {
    const both = linkFieldsShown({ ...TASK, status: 'waiting' }, {});
    expect(unpickedLink({ project: 'Zeph', waitingOn: 'Mar' }, both)).toEqual({
      field: 'waitingOn',
      text: 'Mar',
    });
    expect(unpickedLink({ project: 'Zeph' }, both)).toEqual({ field: 'project', text: 'Zeph' });
    expect(unpickedLink({}, both)).toBeNull();
    expect(unpickedLink(undefined, both)).toBeNull();
  });

  it('shows who it waits on only while the row asks: a task that is, or is being made, Waiting', () => {
    expect(linkFieldsShown({ ...TASK, status: 'waiting' }, {})).toEqual(['waitingOn', 'project']);
    expect(linkFieldsShown(TASK, { status: 'waiting' })).toEqual(['waitingOn', 'project']);
    expect(linkFieldsShown({ ...TASK, status: 'waiting' }, { status: 'someday' })).toEqual([
      'project',
    ]);
    expect(linkFieldsShown(TASK, {})).toEqual(['project']);
    expect(linkFieldsShown(null, { status: 'waiting' })).toEqual(['project']);
  });

  it('passes over text typed in a field the row does not show', () => {
    const typed = { project: 'Zeph', waitingOn: 'Mar' };
    expect(unpickedLink(typed, ['project'])).toEqual({ field: 'project', text: 'Zeph' });
    expect(unpickedLink({ waitingOn: 'Mar' }, ['project'])).toBeNull();
  });

  it('lets go of what a field not shown holds typed, and keeps the rest', () => {
    const typed = { project: 'Zeph', waitingOn: 'Mar' };
    expect(typedInShown(typed, ['project'])).toEqual({ project: 'Zeph' });
    expect(typedInShown(typed, ['waitingOn', 'project'])).toEqual(typed);
    expect(typedInShown(undefined, ['project'])).toEqual({});
  });

  it('keeps a refusal standing while its field is shown and holds the text it names', () => {
    const over = { field: 'waitingOn', text: 'Mar' } as const;
    const shown = ['waitingOn', 'project'] as const;
    expect(refusalStands(over, { typed: { waitingOn: 'Mar' }, shown })).toBe(true);
    // The other field typed in changes nothing the refusal names.
    expect(refusalStands(over, { typed: { waitingOn: 'Mar', project: 'Zephyr' }, shown })).toBe(
      true,
    );
    expect(refusalStands(over, { typed: { waitingOn: 'Mara' }, shown })).toBe(false);
    expect(refusalStands(over, { typed: { project: 'Zeph' }, shown })).toBe(false);
    expect(refusalStands(over, { typed: undefined, shown })).toBe(false);
    expect(refusalStands(over, { typed: { waitingOn: 'Mar' }, shown: ['project'] })).toBe(false);
  });

  it('says what was typed, and the two ways out', () => {
    expect(unpickedRefusal('Mar')).toBe(
      '“Mar” is typed but not picked. Pick it from the list, or clear it.',
    );
  });
});
