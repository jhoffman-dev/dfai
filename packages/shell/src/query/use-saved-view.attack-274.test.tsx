// @vitest-environment jsdom
/**
 * Adversarial pass on #260 (PR #274): a card moved on a board is drawn where
 * the move puts it until a read stands for its write. A card moved twice
 * before that read must be drawn as both moves leave it — as its file is.
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

describe('useSavedView — a card moved twice before the index reads it back (#260, PR #274)', () => {
  it('draws a rolled repeating task moved again with the due date its file now holds', async () => {
    const page = await board();
    // Dropped on done: rolled on, back in play and due next week, and written.
    act(() => page.view.result.current.moveCard({ path: WATER, value: 'done' }));
    await waitFor(() => expect(page.files[WATER]).toContain('due: 2026-09-27'));

    // Moved on again before the index has read the roll.
    const release = page.hold();
    act(() => page.view.result.current.moveCard({ path: WATER, value: 'doing' }));
    const card = page.view.result.current.board.columns
      .flatMap((column) => column.rows)
      .find((row) => row.path === WATER);

    expect(page.cardsIn('doing')).toContain(WATER);
    // Expected '2026-09-27' (what the file says, and what the read-back will draw);
    // received '2026-09-20': the second move replaces the first's pending values
    // instead of adding to them, so the card is drawn with its pre-roll due date.
    expect(card?.values['due']).toBe('2026-09-27');
    release();
    await waitFor(() => expect(page.files[WATER]).toContain('status: doing'));
    expect(page.files[WATER]).toContain('due: 2026-09-27');
  });
});
