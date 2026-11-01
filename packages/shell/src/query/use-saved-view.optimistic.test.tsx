// @vitest-environment jsdom
/**
 * #260: a card dropped on a board is drawn in its new column at once, before
 * its write lands and the index reads it back — so it no longer snaps back
 * to where it was for a beat (#257). A repeating task dropped on done is
 * drawn where finishing it puts it. A write that fails puts the card back
 * and says why; a read from before the write never puts it back meanwhile.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, type ObjectType, type PropertyDef } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, openNote, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { createTickMemory } from './tick-memory.ts';
import { useBoardAsPending } from './use-pending-cards.ts';
import { useSavedView } from './use-saved-view.ts';
import { useViewDrafts } from './use-view-drafts.ts';

const VIEW_PATH = createVaultPath('.atlas/views/Board.md');
const VIEW = [
  '---',
  'atlas: view',
  'type: task',
  'layout: board',
  'groupBy: status',
  'columns: [status, due]',
  'limit: 50',
  '---',
  '',
  '# Board',
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
      property('due', { kind: 'date' }),
      property('recurrence'),
    ],
  },
];

const ONE_OFF = 'one off.md';
const WATER = 'water the plants.md';
const FILES: Record<string, string> = {
  [ONE_OFF]: '---\ntype: task\nstatus: doing\n---\n\nOnce.\n',
  [WATER]: '---\ntype: task\nstatus: doing\ndue: 2026-09-20\nrecurrence: weekly\n---\n\nWeekly.\n',
};

const noPane: OpenEditors = {
  register: () => {},
  setPropertiesIfOpen: async () => false,
  savePane: () => {},
  reloadOthers: () => {},
};

/** A promise and the function that settles it, to hold a write mid-way. */
function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

const field = (text: string, key: string) =>
  new RegExp(`^${key}: (.*)$`, 'm').exec(text)?.[1] ?? null;

async function board() {
  const files: Record<string, string> = { [VIEW_PATH]: VIEW, ...FILES };
  // What the index holds: each card's values as of the last refresh.
  const indexedNow = () =>
    [ONE_OFF, WATER].map((at) => {
      const text = files[at] ?? '';
      return [
        at,
        at.slice(0, -3),
        field(text, 'status'),
        field(text, 'due'),
        field(text, 'recurrence'),
      ];
    });
  let indexed = indexedNow();
  let held: Promise<void> | null = null;
  let failing: string | null = null;
  const asked: string[] = [];
  const fs = fakeVaultFs({
    readTextFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return { text, modified: 1 };
    },
    writeTextFile: async ({ path, contents }) => {
      if (held !== null) await held;
      if (failing !== null) throw new Error(failing);
      files[path] = contents;
      return 2;
    },
  });
  const index = fakeIndexPort({
    query: async (sql: string) => {
      asked.push(sql);
      return {
        columns: ['path', 'title', 'status', 'due', 'recurrence'],
        rows: indexed,
        truncated: false,
      };
    },
  });
  const note = await openNote({ fs, markdown: remarkMarkdown, path: VIEW_PATH });
  const tickMemory = createTickMemory();
  const activity = recordingActivity();
  const view = renderHook(
    ({ indexKey }: { indexKey: string }) => {
      const saved = useSavedView({
        activity,
        note,
        index,
        fs,
        markdown: remarkMarkdown,
        types: TYPES,
        notePaths: [ONE_OFF, WATER],
        indexKey,
        onChanged: () => {},
        editors: noPane,
        tickMemory,
        drafts: useViewDrafts('/vault'),
        viewPaths: [VIEW_PATH],
      });
      // The board as it is drawn: what the pane hands it, with its moves laid over.
      const board = useBoardAsPending({
        ...saved.pendingBoard,
        read: { columns: saved.columns, lanes: saved.lanes },
      });
      return { ...saved, board };
    },
    { initialProps: { indexKey: 'ready:1' } },
  );
  await waitFor(() => expect(view.result.current.rows).toHaveLength(2));
  const cardsIn = (value: string) =>
    view.result.current.board.columns
      .find((column) => column.value === value)
      ?.rows.map((row) => row.path) ?? [];
  return {
    view,
    files,
    asked,
    cardsIn,
    /** The index reads the files again, and says so with a new key. */
    refresh: (indexKey: string) => {
      indexed = indexedNow();
      view.rerender({ indexKey });
    },
    hold: () => {
      const writes = gate();
      held = writes.opened;
      return () => {
        held = null;
        writes.open();
      };
    },
    fail: (reason: string) => {
      failing = reason;
    },
  };
}

describe('useSavedView — a card moved on a board shows at once (#260)', () => {
  it('reads what a repeating task rolls on by, without showing it as a field', async () => {
    const page = await board();
    expect(page.asked.some((sql) => sql.includes('"recurrence"'))).toBe(true);
    expect(page.view.result.current.fields).not.toContain('recurrence');
  });

  it('draws the card in the column it was dropped in before its write lands', async () => {
    const page = await board();
    const release = page.hold();

    act(() => page.view.result.current.moveCard({ path: ONE_OFF, value: 'done' }));

    expect(page.cardsIn('done')).toEqual([ONE_OFF]);
    expect(page.cardsIn('doing')).toEqual([WATER]);
    release();
    await waitFor(() => expect(page.files[ONE_OFF]).toContain('status: done'));
  });

  it('draws a repeating task dropped on done where finishing it puts it: back in play, due next week', async () => {
    const page = await board();
    const release = page.hold();

    act(() => page.view.result.current.moveCard({ path: WATER, value: 'done' }));

    expect(page.cardsIn('done')).toEqual([]);
    expect(page.cardsIn('backlog')).toEqual([WATER]);
    const card = page.view.result.current.board.columns
      .flatMap((column) => column.rows)
      .find((row) => row.path === WATER);
    expect(card?.values['due']).toBe('2026-09-27');
    release();
    await waitFor(() => expect(page.files[WATER]).toContain('due: 2026-09-27'));
  });

  it('keeps the card where it was dropped through a read of the index begun before its write landed', async () => {
    const page = await board();
    const release = page.hold();
    act(() => page.view.result.current.moveCard({ path: ONE_OFF, value: 'done' }));

    // Something else is refreshed meanwhile: the view runs again, and still finds it under doing.
    const before = page.view.result.current.result;
    page.view.rerender({ indexKey: 'ready:2' });
    await waitFor(() => expect(page.view.result.current.result).not.toBe(before));
    expect(page.cardsIn('done')).toEqual([ONE_OFF]);

    release();
    await waitFor(() => expect(page.files[ONE_OFF]).toContain('status: done'));
    expect(page.cardsIn('done')).toEqual([ONE_OFF]);

    page.refresh('ready:3');
    await waitFor(() => expect(page.view.result.current.result?.rows[0]?.[2]).toBe('done'));
    expect(page.cardsIn('done')).toEqual([ONE_OFF]);
    expect(page.cardsIn('doing')).toEqual([WATER]);
  });

  it('draws what the index says once it has caught up, even when that is not where the card was dropped', async () => {
    const page = await board();
    act(() => page.view.result.current.moveCard({ path: ONE_OFF, value: 'done' }));
    await waitFor(() => expect(page.files[ONE_OFF]).toContain('status: done'));

    // Another program moves it on before the index reads the vault again.
    page.files[ONE_OFF] = '---\ntype: task\nstatus: backlog\n---\n\nOnce.\n';
    page.refresh('ready:2');

    await waitFor(() => expect(page.cardsIn('backlog')).toEqual([ONE_OFF]));
    expect(page.cardsIn('done')).toEqual([]);
  });

  it('puts the card back, saying why, when its write fails', async () => {
    const page = await board();
    page.fail('The disk is full.');
    const release = page.hold();

    act(() => page.view.result.current.moveCard({ path: ONE_OFF, value: 'done' }));
    expect(page.cardsIn('done')).toEqual([ONE_OFF]);

    release();
    await waitFor(() => expect(page.view.result.current.board.failure).toMatch(/disk is full/));
    // Said on the board, which stays drawn: not the view's error, which a run of it clears.
    expect(page.view.result.current.error).toBeNull();
    expect(page.cardsIn('doing')).toEqual([ONE_OFF, WATER]);
    expect(page.cardsIn('done')).toEqual([]);
  });
});
