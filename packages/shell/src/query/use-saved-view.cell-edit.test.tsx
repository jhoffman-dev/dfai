// @vitest-environment jsdom
/**
 * #300: a cell committed in a view's table writes its note once, typed as
 * its editor committed it, and is drawn as committed before the index reads
 * it back — the pending-row rules a board's drag keeps (#260). A commit from
 * a row whose cell changed since the edit began is refused, writing nothing,
 * and the refusal is said over the table. A relation's notes are read only
 * once its picker asks for them.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, type ObjectType, type PropertyDef } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, openNote, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { createTickMemory } from './tick-memory.ts';
import { useTableAsPending } from './use-pending-cards.ts';
import { useSavedView } from './use-saved-view.ts';
import { useViewDrafts } from './use-view-drafts.ts';

const VIEW_PATH = createVaultPath('.atlas/views/Tasks.md');
const VIEW = [
  '---',
  'atlas: view',
  'type: task',
  'columns: [status, phase, owner]',
  '---',
  '',
  '# Tasks',
  '',
].join('\n');

const property = (key: string, extra: Partial<PropertyDef> = {}): PropertyDef => ({
  key,
  kind: 'text',
  label: key,
  required: false,
  options: [],
  target: null,
  many: false,
  ...extra,
});

const TYPES: readonly ObjectType[] = [
  {
    name: 'task',
    label: 'Task',
    properties: [
      property('status', { kind: 'select', options: ['backlog', 'doing', 'done'] }),
      property('phase', { kind: 'number' }),
      property('owner', { kind: 'relation', target: 'person' }),
    ],
  },
];

const HALL = 'book the hall.md';
const FILES: Record<string, string> = {
  [HALL]: '---\ntype: task\nstatus: backlog\nphase: 2\n---\n\nFor Larkspur Payroll.\n',
};

const noPane: OpenEditors = {
  register: () => {},
  setPropertiesIfOpen: async () => false,
  savePane: () => {},
  reloadOthers: () => {},
};

const field = (text: string, key: string) =>
  new RegExp(`^${key}: (.*)$`, 'm').exec(text)?.[1] ?? null;

async function table() {
  const files: Record<string, string> = { [VIEW_PATH]: VIEW, ...FILES };
  const indexedNow = () => {
    const text = files[HALL] ?? '';
    const phase = field(text, 'phase');
    return [[HALL, 'book the hall', field(text, 'status'), phase === null ? null : Number(phase)]];
  };
  let indexed = indexedNow();
  let held: Promise<void> | null = null;
  let failing: string | null = null;
  let peopleFailing = false;
  const writes: string[] = [];
  const peopleAsked: string[] = [];
  const fs = fakeVaultFs({
    readTextFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return { text, modified: 1 };
    },
    writeTextFile: async ({ path, contents }) => {
      if (held !== null) await held;
      if (failing !== null) throw new Error(failing);
      writes.push(path);
      files[path] = contents;
      return 2;
    },
  });
  const index = fakeIndexPort({
    query: async (sql: string) =>
      sql.includes('v_task')
        ? { columns: ['path', 'title', 'status', 'phase'], rows: indexed, truncated: false }
        : { columns: [], rows: [], truncated: false },
    notesOfType: async (type: string) => {
      peopleAsked.push(type);
      if (peopleFailing) throw new Error('The index is not open.');
      return [{ path: 'people/Mara Quill.md', title: 'Mara Quill' }];
    },
  });
  const note = await openNote({ fs, markdown: remarkMarkdown, path: VIEW_PATH });
  const tickMemory = createTickMemory();
  const view = renderHook(
    ({ indexKey }: { indexKey: string }) => {
      const saved = useSavedView({
        activity: recordingActivity(),
        note,
        index,
        fs,
        markdown: remarkMarkdown,
        types: TYPES,
        notePaths: [HALL],
        indexKey,
        onChanged: () => {},
        editors: noPane,
        tickMemory,
        drafts: useViewDrafts('/vault'),
        viewPaths: [VIEW_PATH],
      });
      // The table as it is drawn: the view's result with its cells' edits laid over.
      const shown = useTableAsPending({
        pending: saved.pendingBoard.pending,
        result: saved.result,
      });
      return { ...saved, shown };
    },
    { initialProps: { indexKey: 'ready:1' } },
  );
  await waitFor(() => expect(view.result.current.result?.rows).toHaveLength(1));
  const cell = (column: string) => {
    const shown = view.result.current.shown.result;
    const at = shown?.columns.indexOf(column) ?? -1;
    return shown?.rows[0]?.[at];
  };
  return {
    view,
    files,
    writes,
    peopleAsked,
    cell,
    refresh: (indexKey: string) => {
      indexed = indexedNow();
      view.rerender({ indexKey });
    },
    hold: () => {
      let open: () => void = () => {};
      held = new Promise<void>((resolve) => (open = resolve));
      return () => {
        held = null;
        open();
      };
    },
    fail: (reason: string | null) => {
      failing = reason;
    },
    failPeople: (failing: boolean) => {
      peopleFailing = failing;
    },
  };
}

describe('useSavedView — a cell edited in place (#300)', () => {
  it('writes a typed value once, as its editor typed it', async () => {
    const { view, files, writes } = await table();
    await act(() =>
      view.result.current.editCell({
        path: HALL,
        column: 'phase',
        value: 3,
        began: { value: 2 },
      }),
    );
    expect(writes).toEqual([HALL]);
    expect(field(files[HALL] ?? '', 'phase')).toBe('3');
    expect(files[HALL]).toContain('For Larkspur Payroll.');
  });

  it('draws the cell as committed before its write lands, and as read once the index has it', async () => {
    const { view, cell, hold, refresh } = await table();
    const release = hold();
    let landed: Promise<void> = Promise.resolve();
    act(() => {
      landed = view.result.current.editCell({
        path: HALL,
        column: 'status',
        value: 'doing',
        began: { value: 'backlog' },
      });
    });
    expect(cell('status')).toBe('doing');
    release();
    await act(() => landed);
    refresh('ready:2');
    await waitFor(() => expect(view.result.current.result?.rows[0]?.[2]).toBe('doing'));
    expect(cell('status')).toBe('doing');
  });

  it('refuses a commit from a row whose cell changed since the edit began, and says so', async () => {
    const { view, files, writes, cell } = await table();
    const before = files[HALL];
    let refused: unknown = null;
    await act(() =>
      view.result.current
        .editCell({ path: HALL, column: 'status', value: 'doing', began: { value: 'done' } })
        .catch((cause: unknown) => {
          refused = cause;
        }),
    );
    expect(refused).toBeInstanceOf(Error);
    expect(writes).toEqual([]);
    expect(files[HALL]).toBe(before);
    expect(cell('status')).toBe('backlog');
    expect(view.result.current.shown.failure).toMatch(/changed while it was being edited/);
  });

  it('puts the cell back and says why when its write fails', async () => {
    const { view, cell, fail } = await table();
    fail('The disk is full.');
    let failed = false;
    await act(() =>
      view.result.current
        .editCell({ path: HALL, column: 'status', value: 'done', began: { value: 'backlog' } })
        .catch(() => {
          failed = true;
        }),
    );
    expect(failed).toBe(true);
    expect(cell('status')).toBe('backlog');
    expect(view.result.current.shown.failure).toMatch(/The disk is full/);
  });

  it('a commit the caller does not wait on raises nothing when it fails', async () => {
    const { view, fail } = await table();
    fail('The disk is full.');
    // Ignored, as a table ignores a commit's promise: the failure is said over the table.
    act(() => {
      void view.result.current.editCell({ path: HALL, column: 'phase', value: 4 });
    });
    await waitFor(() => expect(view.result.current.shown.failure).toMatch(/disk is full/));
  });

  it('a refused commit the caller does not wait on raises nothing either', async () => {
    const { view, writes } = await table();
    act(() => {
      void view.result.current.editCell({
        path: HALL,
        column: 'status',
        value: 'doing',
        began: { value: 'done' },
      });
    });
    await waitFor(() => expect(view.result.current.shown.failure).toMatch(/being edited/));
    expect(writes).toEqual([]);
  });

  it('reads a relation’s notes only once its picker asks, then offers them', async () => {
    const { view, peopleAsked } = await table();
    expect(peopleAsked).toEqual([]);
    expect(view.result.current.relationChoices).toEqual({});
    act(() => view.result.current.wantRelationChoices('owner'));
    await waitFor(() =>
      expect(view.result.current.relationChoices.owner).toEqual([
        { path: 'people/Mara Quill.md', title: 'Mara Quill', type: 'person' },
      ]),
    );
    expect(peopleAsked).toEqual(['person']);
  });

  it('reads a relation’s notes again on the next opening once the index changed, not before', async () => {
    const { view, peopleAsked, refresh } = await table();
    act(() => view.result.current.wantRelationChoices('owner'));
    await waitFor(() => expect(peopleAsked).toEqual(['person']));
    refresh('ready:2');
    await waitFor(() => expect(view.result.current.result?.rows).toHaveLength(1));
    // No picker open: the change is not read.
    expect(peopleAsked).toEqual(['person']);
    act(() => view.result.current.wantRelationChoices('owner'));
    await waitFor(() => expect(peopleAsked).toEqual(['person', 'person']));
    // Opened again on the same index: what was read stands.
    act(() => view.result.current.wantRelationChoices('owner'));
    expect(peopleAsked).toEqual(['person', 'person']);
  });

  it('says why a relation’s notes could not be read, and tries again on the next opening', async () => {
    const { view, failPeople } = await table();
    failPeople(true);
    act(() => view.result.current.wantRelationChoices('owner'));
    await waitFor(() =>
      expect(view.result.current.relationChoiceProblems.owner).toMatch(/could not be read/),
    );
    expect(view.result.current.relationChoices.owner).toBeUndefined();
    failPeople(false);
    act(() => view.result.current.wantRelationChoices('owner'));
    await waitFor(() => expect(view.result.current.relationChoices.owner).toHaveLength(1));
    expect(view.result.current.relationChoiceProblems.owner).toBeUndefined();
  });

  it('keeps saying why its own write failed when a cell edited meanwhile is refused for it', async () => {
    const { view, files, fail, hold, cell } = await table();
    const release = hold();
    fail('The disk is full.');
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = view.result.current.editCell({
        path: HALL,
        column: 'status',
        value: 'doing',
        began: { value: 'backlog' },
      });
      first.catch(() => undefined);
    });
    // Edited again while the first is drawn as pending: the edit begins on 'doing'.
    expect(cell('status')).toBe('doing');
    release();
    await act(() => first.catch(() => undefined));
    expect(cell('status')).toBe('backlog');
    fail(null);
    await act(() =>
      view.result.current
        .editCell({ path: HALL, column: 'status', value: 'done', began: { value: 'doing' } })
        .catch(() => undefined),
    );
    expect(view.result.current.shown.failure).toMatch(/The disk is full/);
    expect(files[HALL]).toContain('status: backlog');
  });

  it('writes a cell edited again while its own last commit is still pending', async () => {
    const { view, files, hold, cell, writes } = await table();
    const release = hold();
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = view.result.current.editCell({
        path: HALL,
        column: 'phase',
        value: 3,
        began: { value: 2 },
      });
    });
    expect(cell('phase')).toBe(3);
    let second: Promise<void> = Promise.resolve();
    act(() => {
      second = view.result.current.editCell({
        path: HALL,
        column: 'phase',
        value: 4,
        began: { value: cell('phase') },
      });
    });
    release();
    await act(() => Promise.all([first, second]));
    expect(writes).toEqual([HALL, HALL]);
    expect(field(files[HALL] ?? '', 'phase')).toBe('4');
    expect(view.result.current.shown.failure).toBeNull();
  });

  it('Tab along a row writes the next cell over a neighbour still pending, both kept', async () => {
    const { view, files, hold, cell } = await table();
    const release = hold();
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = view.result.current.editCell({
        path: HALL,
        column: 'status',
        value: 'doing',
        began: { value: 'backlog' },
      });
    });
    let second: Promise<void> = Promise.resolve();
    act(() => {
      second = view.result.current.editCell({
        path: HALL,
        column: 'phase',
        value: 5,
        began: { value: cell('phase') },
      });
    });
    release();
    await act(() => Promise.all([first, second]));
    expect(field(files[HALL] ?? '', 'status')).toBe('doing');
    expect(field(files[HALL] ?? '', 'phase')).toBe('5');
    expect(view.result.current.shown.failure).toBeNull();
  });

  it('reads a cell holding several values from the note, once its own writes have landed', async () => {
    const { view, hold } = await table();
    const release = hold();
    let write: Promise<void> = Promise.resolve();
    act(() => {
      write = view.result.current.editCell({
        path: HALL,
        column: 'owner',
        value: ['[[Mara Quill]]'],
      });
    });
    let read: Promise<unknown> = Promise.resolve();
    act(() => {
      read = view.result.current.readHeldCell({ path: HALL, column: 'owner' });
    });
    release();
    await act(() => write);
    // Read after the write, not from the file as it was before it.
    expect(await read).toEqual(['[[Mara Quill]]']);
  });
});
