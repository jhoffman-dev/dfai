// @vitest-environment jsdom
/**
 * Issue #6: a saved view's groups and sub-groups — a table's header rows, a
 * board's columns and swimlanes — and the writes they make: a card moved
 * across a column and a lane is given both properties in one write, and a
 * note added inside a group carries that group's values.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, parseObjectType, type VaultPath } from '@dfai/domain';
import { fakeIndexPort, fakeVaultFs, openNote, recordingActivity } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { OpenEditors } from '../panes/open-editors.ts';
import { createTickMemory } from './tick-memory.ts';
import { useSavedView } from './use-saved-view.ts';
import { useViewDrafts } from './use-view-drafts.ts';
import { localToday } from '../today.ts';

/** Where a new task lands: its type's home folder for this month (#214). */
const taskHome = () => `Tasks/${localToday().slice(0, 4)}/${localToday().slice(5, 7)}`;

/** Where the hooks under test record what they give up on; these tests do not read it. */
const ACTIVITY = recordingActivity();

const VIEW_PATH = createVaultPath('.atlas/views/Work.md');

const view = (layout: string, { groupBy = 'status', subGroupBy = 'area' } = {}) =>
  [
    '---',
    'atlas: view',
    'type: task',
    `layout: ${layout}`,
    `groupBy: ${groupBy}`,
    `subGroupBy: ${subGroupBy}`,
    'columns: [status, phase]',
    'limit: 50',
    '---',
    '',
  ].join('\n');

const TYPES = [
  parseObjectType({
    name: 'task',
    properties: {
      status: { kind: 'select', options: ['backlog', 'doing', 'done'] },
      area: { kind: 'select', options: ['home', 'work'] },
      phase: 'number',
      flagged: 'checkbox',
    },
  }),
];

const INDEX = fakeIndexPort({
  query: async () => ({
    columns: ['path', 'title', 'status', 'phase', 'area'],
    rows: [
      ['a.md', 'A', 'doing', 1, 'home'],
      ['b.md', 'B', 'doing', 2, 'work'],
      ['c.md', 'C', 'backlog', 3, null],
    ],
    truncated: false,
  }),
});

function fakeEditors() {
  const asked: { path: VaultPath; values: unknown }[] = [];
  const registry: OpenEditors = {
    register: () => {},
    setPropertiesIfOpen: async (args) => {
      asked.push({ path: args.path, values: args.values });
      return true;
    },
    savePane: () => {},
    reloadOthers: () => {},
  };
  return { registry, asked };
}

const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function show(layout: 'table' | 'board', text = view(layout)) {
  const files: Record<string, string> = { [VIEW_PATH]: text };
  const created: { path: string; contents: string }[] = [];
  const fs = {
    ...fakeVaultFs({
      readTextFile: async (path) => ({ text: files[path] ?? '', modified: 1 }),
    }),
    createNote: async (args: { path: VaultPath; contents: string }) => {
      created.push(args);
      return 0;
    },
  };
  const editors = fakeEditors();
  const note = await openNote({ fs, markdown: remarkMarkdown, path: VIEW_PATH });
  const hook = renderHook(() =>
    useSavedView({
      activity: ACTIVITY,
      note,
      index: INDEX,
      fs,
      markdown: remarkMarkdown,
      types: TYPES,
      notePaths: [],
      indexKey: 'ready:1',
      onChanged: () => {},
      editors: editors.registry,
      tickMemory: createTickMemory(),
      drafts: useViewDrafts('/vault'),
      viewPaths: [VIEW_PATH],
    }),
  );
  await waitFor(() => expect(hook.result.current.rows).toHaveLength(3));
  return { hook, asked: editors.asked, created };
}

describe('a saved view’s groups', () => {
  it('reads what it groups by even when it is not a shown column', async () => {
    const { hook } = await show('table');
    expect(hook.result.current.hidden).toContain('area');
    expect(hook.result.current.fields).not.toContain('area');
  });

  it('groups a table, then sub-groups each group, with only the values rows have', async () => {
    const { hook } = await show('table');
    const outline = hook.result.current.groups.map((group) => [
      group.label,
      group.subgroups.map((sub) => [sub.label, sub.rows.map((row) => row.title)]),
    ]);
    expect(outline).toEqual([
      ['backlog', [['No value', ['C']]]],
      [
        'doing',
        [
          ['home', ['A']],
          ['work', ['B']],
        ],
      ],
    ]);
    expect(hook.result.current.lanes).toEqual([]);
  });

  it('draws a board as every column, crossed with a lane per sub-group', async () => {
    const { hook } = await show('board');
    expect(hook.result.current.columns.map((column) => column.label)).toEqual([
      'backlog',
      'doing',
      'done',
    ]);
    expect(hook.result.current.lanes.map((lane) => lane.group.label)).toEqual([
      'home',
      'work',
      'No value',
    ]);
    expect(hook.result.current.groups).toEqual([]);
  });

  it('offers every property in the Group control', async () => {
    const { hook } = await show('board');
    expect(hook.result.current.groupChoices.map((choice) => choice.key)).toEqual([
      'status',
      'area',
      'phase',
      'flagged',
    ]);
  });
});

describe('moving a card across columns and lanes', () => {
  it('writes both properties in one write', async () => {
    const { hook, asked } = await show('board');
    act(() => hook.result.current.moveCard({ path: 'c.md', value: 'doing', lane: 'work' }));
    await settle();
    expect(asked).toEqual([{ path: 'c.md', values: { status: 'doing', area: 'work' } }]);
  });

  it('finishing work in the move still rolls a repeating task forward, in the same write', async () => {
    const { hook, asked } = await show('board');
    act(() => hook.result.current.moveCard({ path: 'a.md', value: 'done', lane: 'work' }));
    await settle();
    expect(asked).toHaveLength(1);
    const rule = asked[0]?.values as (properties: Record<string, unknown>) => unknown;
    expect(rule({ status: 'doing' })).toEqual({ status: 'done', area: 'work' });
    expect(rule({ status: 'doing', due: '2026-01-05', recurrence: 'every week' })).toMatchObject({
      status: 'backlog',
      due: '2026-01-12',
      area: 'work',
    });
  });

  it('writes only the lane when the column stays', async () => {
    const { hook, asked } = await show('board');
    act(() => hook.result.current.moveCard({ path: 'a.md', lane: null }));
    await settle();
    expect(asked).toEqual([{ path: 'a.md', values: { area: null } }]);
  });

  it('writes nothing for a move that changes neither', async () => {
    const { hook, asked } = await show('board');
    act(() => hook.result.current.moveCard({ path: 'a.md' }));
    await settle();
    expect(asked).toEqual([]);
  });
});

describe('adding a note inside a group', () => {
  it('gives a card added in a cell both its column and its lane', async () => {
    const { hook, created } = await show('board');
    act(() => hook.result.current.addCard({ value: 'doing', lane: 'home', name: 'Paint' }));
    await settle();
    expect(created[0]?.path).toBe(`${taskHome()}/Paint.md`);
    expect(created[0]?.contents).toContain('status: doing');
    expect(created[0]?.contents).toContain('area: home');
  });

  it('gives a note added under a table’s sub-group its group’s values, and says where', async () => {
    const { hook, created } = await show('table');
    const doing = hook.result.current.groups[1];
    const work = doing?.subgroups[1];
    if (doing === undefined || work === undefined) throw new Error('no groups');
    let path: VaultPath | null = null;
    await act(async () => {
      path = await hook.result.current.addInGroup([doing, work]);
    });
    expect(path).toBe(`${taskHome()}/New task.md`);
    expect(created[0]?.contents).toContain('status: doing');
    expect(created[0]?.contents).toContain('area: work');
  });

  it('gives nothing for "No value"', async () => {
    const { hook, created } = await show('table');
    const backlog = hook.result.current.groups[0];
    const none = backlog?.subgroups[0];
    if (backlog === undefined || none === undefined) throw new Error('no groups');
    await act(async () => {
      await hook.result.current.addInGroup([backlog, none]);
    });
    expect(created[0]?.contents).toContain('status: backlog');
    expect(created[0]?.contents).not.toContain('area');
  });
});

describe('the Group control changing the view', () => {
  it('takes the sub-grouping away with the grouping, as an unsaved change', async () => {
    const { hook } = await show('table');
    act(() => hook.result.current.setGroupBy(null));
    expect(hook.result.current.display.groupBy).toBeNull();
    expect(hook.result.current.display.subGroupBy).toBeNull();
    expect(hook.result.current.groups).toEqual([]);
    expect(hook.result.current.edited).toBe(true);
  });

  it('sub-groups by another property at once, and saves it to the view note', async () => {
    const { hook, asked } = await show('table');
    act(() => hook.result.current.setSubGroupBy('phase'));
    expect(hook.result.current.display.subGroupBy).toBe('phase');
    expect(hook.result.current.groups[1]?.subgroups.map((sub) => sub.label)).toEqual(['1', '2']);
    act(() => hook.result.current.save());
    await settle();
    expect(asked).toEqual([{ path: VIEW_PATH, values: { subGroupBy: 'phase' } }]);
  });
});

describe('a card moved by its column alone', () => {
  it('writes only the column', async () => {
    const { hook, asked } = await show('board');
    act(() => hook.result.current.moveCard({ path: 'c.md', value: 'doing' }));
    await settle();
    expect(asked).toEqual([{ path: 'c.md', values: { status: 'doing' } }]);
  });
});

describe('a card moved on a board by a number and a checkbox', () => {
  const byPhase = view('board', { groupBy: 'phase', subGroupBy: 'flagged' });

  it('writes the number as a number and the tick as a tick, as the API move does', async () => {
    const { hook, asked } = await show('board', byPhase);
    act(() => hook.result.current.moveCard({ path: 'c.md', value: '2', lane: 'true' }));
    await settle();
    expect(asked).toEqual([{ path: 'c.md', values: { phase: 2, flagged: true } }]);
  });

  it('unticks a card dropped into the unticked lane', async () => {
    const { hook, asked } = await show('board', byPhase);
    act(() => hook.result.current.moveCard({ path: 'a.md', lane: 'false' }));
    await settle();
    expect(asked).toEqual([{ path: 'a.md', values: { flagged: false } }]);
  });
});
