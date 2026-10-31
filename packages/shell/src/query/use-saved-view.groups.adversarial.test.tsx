// @vitest-environment jsdom
/**
 * Adversarial pass on issue #6 (groups, sub-groups, swimlanes): the writes a
 * board with lanes makes on a repeating task, and a grouping that names a
 * property the type no longer declares.
 *
 * Each test names an invariant the branch once broke, and was seen failing first.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, parseObjectType, type VaultPath } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, openNote, recordingActivity } from '@dfai/application';
import type { IndexPort } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { createTickMemory } from './tick-memory.ts';
import { useSavedView } from './use-saved-view.ts';
import { useViewDrafts } from './use-view-drafts.ts';

/** Where the hooks under test record what they give up on; these tests do not read it. */
const ACTIVITY = recordingActivity();

const VIEW_PATH = createVaultPath('.atlas/views/Work.md');

const TYPES = [
  parseObjectType({
    name: 'task',
    properties: {
      status: { kind: 'select', options: ['backlog', 'doing', 'done'] },
      area: { kind: 'select', options: ['home', 'work'] },
    },
  }),
];

const ROWS = {
  columns: ['path', 'title', 'status', 'area'],
  rows: [
    ['a.md', 'A', 'doing', 'home'],
    ['b.md', 'B', 'backlog', 'work'],
  ],
  truncated: false,
};

/** A note as a repeating weekly task in play, the way the rule reads it. */
const REPEATING = {
  status: 'doing',
  area: 'home',
  due: '2026-01-05',
  recurrence: 'every week',
};

async function show({
  layout,
  groupBy,
  subGroupBy,
  index = fakeIndexPort({ query: async () => ROWS }),
}: {
  layout: 'table' | 'board';
  groupBy: string;
  subGroupBy: string | null;
  index?: IndexPort;
}) {
  const text = [
    '---',
    'atlas: view',
    'type: task',
    `layout: ${layout}`,
    `groupBy: ${groupBy}`,
    ...(subGroupBy === null ? [] : [`subGroupBy: ${subGroupBy}`]),
    'columns: [status]',
    'limit: 50',
    '---',
    '',
  ].join('\n');
  const fs = fakeVaultFs({ readTextFile: async () => ({ text, modified: 1 }) });
  const asked: { path: VaultPath; values: unknown }[] = [];
  const editors: OpenEditors = {
    register: () => {},
    setPropertiesIfOpen: async (args) => {
      asked.push({ path: args.path, values: args.values });
      return true;
    },
    savePane: () => {},
    reloadOthers: () => {},
  };
  const note = await openNote({ fs, markdown: remarkMarkdown, path: VIEW_PATH });
  const hook = renderHook(() =>
    useSavedView({
      activity: ACTIVITY,
      note,
      index,
      fs,
      markdown: remarkMarkdown,
      types: TYPES,
      notePaths: [],
      indexKey: 'ready:1',
      onChanged: () => {},
      editors,
      tickMemory: createTickMemory(),
      drafts: useViewDrafts('/vault'),
      viewPaths: [VIEW_PATH],
    }),
  );
  return { hook, asked };
}

const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** What a move wrote, applied to the note's properties as the file write would. */
function written(values: unknown, properties: Record<string, unknown>): Record<string, unknown> {
  return typeof values === 'function'
    ? (values as (p: Record<string, unknown>) => Record<string, unknown>)(properties)
    : (values as Record<string, unknown>);
}

describe('a board in area columns with status swimlanes, on a repeating task', () => {
  it('a card dropped in the "work" column ends up in it, since area is not the status', async () => {
    const { hook, asked } = await show({ layout: 'board', groupBy: 'area', subGroupBy: 'status' });
    await waitFor(() => expect(hook.result.current.rows).toHaveLength(2));
    act(() => hook.result.current.moveCard({ path: 'a.md', value: 'work' }));
    await settle();
    expect(asked).toHaveLength(1);
    const after = written(asked[0]?.values, REPEATING);
    expect(after['area']).toBe('work');
    expect(after['due'] ?? REPEATING.due).toBe(REPEATING.due);
  });

  it('one drop that finishes the task rolls the series forward exactly once', async () => {
    const { hook, asked } = await show({ layout: 'board', groupBy: 'area', subGroupBy: 'status' });
    await waitFor(() => expect(hook.result.current.rows).toHaveLength(2));
    act(() => hook.result.current.moveCard({ path: 'a.md', value: 'work', lane: 'done' }));
    await settle();
    const after = written(asked[0]?.values, REPEATING);
    expect(after['due']).toBe('2026-01-12');
  });

  it('one drop into a column and a lane gives the card that column', async () => {
    const { hook, asked } = await show({ layout: 'board', groupBy: 'area', subGroupBy: 'status' });
    await waitFor(() => expect(hook.result.current.rows).toHaveLength(2));
    act(() => hook.result.current.moveCard({ path: 'a.md', value: 'work', lane: 'done' }));
    await settle();
    expect(written(asked[0]?.values, REPEATING)['area']).toBe('work');
  });
});

describe('a grouping that names a property the type does not declare', () => {
  /**
   * The index's per-type SQL view has a column only for each declared
   * property (index.rs `rebuild_views`), so SQLite refuses any other name with
   * "no such column" — this fake answers the same way.
   */
  const strictIndex = fakeIndexPort({
    query: async (sql) => {
      if (sql.includes('"estimate"')) throw new Error('no such column: estimate');
      return ROWS;
    },
  });

  it('a table grouped by a property since removed from the type still shows its rows', async () => {
    const { hook } = await show({
      layout: 'table',
      groupBy: 'status',
      subGroupBy: 'estimate',
      index: strictIndex,
    });
    await settle();
    await settle();
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.rows).toHaveLength(2);
  });
});
