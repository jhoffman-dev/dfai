// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, type ObjectType, type VaultPath } from '@dfai/domain';
import {
  fakeIndexPort,
  fakeVaultFs,
  openNote,
  type OpenNote,
  recordingActivity,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useSavedView } from './use-saved-view.ts';
import { useViewDrafts } from './use-view-drafts.ts';
import type { OpenEditors } from '../panes/open-editors.ts';
import { createTickMemory, type TickMemory } from './tick-memory.ts';
import { localToday } from '../today.ts';

/** Where a new task lands: its type's home folder for this month (#214). */
const taskHome = () => `Tasks/${localToday().slice(0, 4)}/${localToday().slice(5, 7)}`;

/** Where the hooks under test record what they give up on; these tests do not read it. */
const ACTIVITY = recordingActivity();

/**
 * R13-03: a view writes notes other panes are holding.
 *
 * Dragging a card, editing a cell, rescheduling and moving a bar all write a
 * note that may be open beside the view. Writing the file directly leaves that
 * pane holding a modification time the file has moved past, and its next save
 * is refused — from an everyday gesture rather than from a star.
 */

const VIEW_PATH = createVaultPath('.atlas/views/Board.md');
const TASK_PATH = 'first.md';

const VIEW = [
  '---',
  'atlas: view',
  'type: task',
  'layout: board',
  'groupBy: status',
  'dateKey: due',
  'startKey: start',
  'endKey: end',
  'columns: [status]',
  'limit: 50',
  '---',
  '',
  '# Board',
  '',
].join('\n');

const TASK = ['---', 'type: task', 'status: backlog', '---', '', '# First', ''].join('\n');

const TYPES: readonly ObjectType[] = [
  {
    name: 'task',
    label: 'Task',
    properties: [
      {
        key: 'status',
        kind: 'select',
        label: 'status',
        required: false,
        options: ['backlog', 'doing', 'done'],
        target: null,
        many: false,
      },
    ],
  },
];

/** The panes, with what they were asked to write recorded. */
function fakeEditors(holdsTheNote: boolean) {
  const asked: { path: VaultPath; values: unknown }[] = [];
  const registry: OpenEditors = {
    register: () => {},
    setPropertiesIfOpen: async (args) => {
      asked.push({ path: args.path, values: args.values });
      return holdsTheNote;
    },
    savePane: () => {},
    reloadOthers: () => {},
  };
  return { registry, asked };
}

/** A vault holding the two notes, with every direct write recorded. */
function fakeVault() {
  const files: Record<string, string> = { [VIEW_PATH]: VIEW, [TASK_PATH]: TASK };
  const written: { path: string; contents: string }[] = [];
  const fs = fakeVaultFs({
    readTextFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return { text, modified: 1 };
    },
    writeTextFile: async ({ path, contents }) => {
      written.push({ path, contents });
      files[path] = contents;
      return 2;
    },
  });
  return { fs, written };
}

const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** Built once: a new port on every render would re-run the view for ever. */
const INDEX = fakeIndexPort();
const NOTE_PATHS = [TASK_PATH];

async function openView(fs: ReturnType<typeof fakeVault>['fs']): Promise<OpenNote> {
  return openNote({ fs, markdown: remarkMarkdown, path: VIEW_PATH });
}

async function showView(args: {
  vault: ReturnType<typeof fakeVault>;
  editors: OpenEditors;
  onChanged?: () => void;
  index?: typeof INDEX;
  tickMemory?: TickMemory;
  activity?: ReturnType<typeof recordingActivity>;
}) {
  const tickMemory = args.tickMemory ?? createTickMemory();
  const note = await openView(args.vault.fs);
  const view = renderHook(() =>
    useSavedView({
      activity: args.activity ?? ACTIVITY,
      note,
      index: args.index ?? INDEX,
      fs: args.vault.fs,
      markdown: remarkMarkdown,
      types: TYPES,
      notePaths: NOTE_PATHS,
      indexKey: 'ready:1',
      onChanged: args.onChanged ?? (() => {}),
      editors: args.editors,
      tickMemory,
      drafts: useViewDrafts('/vault'),
      viewPaths: [VIEW_PATH],
    }),
  );
  await waitFor(() => expect(view.result.current.query).not.toBeNull());
  return view;
}

describe('a view writing a note', () => {
  it('moves a card through the pane that holds the note', async () => {
    const vault = fakeVault();
    const { registry, asked } = fakeEditors(true);
    const onChanged = vi.fn();
    const view = await showView({ vault, editors: registry, onChanged });
    act(() => view.result.current.moveCard({ path: TASK_PATH, value: 'doing' }));
    await settle();

    expect(asked).toEqual([{ path: TASK_PATH, values: { status: 'doing' } }]);
    // Not underneath it: that is what leaves the pane unable to save.
    expect(vault.written).toEqual([]);
    expect(onChanged).toHaveBeenCalled();
  });

  it('writes the file itself when no pane holds the note', async () => {
    const vault = fakeVault();
    const { registry, asked } = fakeEditors(false);
    const view = await showView({ vault, editors: registry });

    act(() => view.result.current.moveCard({ path: TASK_PATH, value: 'doing' }));
    await settle();

    expect(asked).toHaveLength(1);
    expect(vault.written).toHaveLength(1);
    expect(vault.written[0]?.contents).toContain('status: doing');
  });

  it('asks the panes first for every gesture that writes a note', async () => {
    const vault = fakeVault();
    const { registry, asked } = fakeEditors(true);
    const view = await showView({ vault, editors: registry });

    await act(() =>
      view.result.current.editCell({ path: TASK_PATH, column: 'status', value: 'doing' }),
    );
    act(() => view.result.current.reschedule({ path: TASK_PATH, start: '2026-09-21', end: null }));
    act(() =>
      view.result.current.moveBar({ path: TASK_PATH, start: '2026-09-21', end: '2026-09-23' }),
    );
    // A view is a note too, and it is the note the pane showing it is holding.
    act(() => view.result.current.toggleSort('status'));
    act(() => view.result.current.save());
    await settle();

    expect(asked.map((write) => write.values)).toEqual([
      { status: 'doing' },
      { due: '2026-09-21' },
      { start: '2026-09-21', end: '2026-09-23' },
      { sorts: [{ key: 'status', direction: 'asc' }] },
    ]);
    expect(vault.written).toEqual([]);
  });
});

describe('the toolbar changing the view', () => {
  const NOT_DONE = { key: 'status', operator: 'isNot', value: 'done' } as const;

  it('draws a filter and a sort at once, and writes nothing until saved', async () => {
    const vault = fakeVault();
    const { registry, asked } = fakeEditors(true);
    const view = await showView({ vault, editors: registry });
    expect(view.result.current.edited).toBe(false);

    act(() => view.result.current.setFilters([NOT_DONE]));
    act(() => view.result.current.setSorts([{ key: 'status', direction: 'desc' }]));
    await settle();

    expect(view.result.current.query?.filters).toEqual([NOT_DONE]);
    expect(view.result.current.query?.sorts).toEqual([{ key: 'status', direction: 'desc' }]);
    expect(view.result.current.edited).toBe(true);
    expect(asked).toEqual([]);

    act(() => view.result.current.save());
    await settle();
    expect(asked).toEqual([
      {
        path: VIEW_PATH,
        values: { filters: [NOT_DONE], sorts: [{ key: 'status', direction: 'desc' }] },
      },
    ]);
  });

  it('is no longer edited once a change is put back the way the note has it', async () => {
    const view = await showView({ vault: fakeVault(), editors: fakeEditors(true).registry });
    act(() => view.result.current.setGroupBy('phase'));
    expect(view.result.current.edited).toBe(true);
    expect(view.result.current.display.groupBy).toBe('phase');
    act(() => view.result.current.setGroupBy('status'));
    expect(view.result.current.edited).toBe(false);
  });

  it('shows, hides and reorders properties, and Reset drops every change', async () => {
    const view = await showView({ vault: fakeVault(), editors: fakeEditors(true).registry });
    act(() => view.result.current.toggleColumn('due'));
    act(() => view.result.current.moveColumn('due', -1));
    expect(view.result.current.query?.columns).toEqual(['due', 'status']);

    act(() => view.result.current.reset());
    expect(view.result.current.query?.columns).toEqual(['status']);
    expect(view.result.current.edited).toBe(false);
  });

  it('saves the changes as a new view, and puts this one back as it was', async () => {
    const created: { path: string; contents: string }[] = [];
    const vault = fakeVault();
    const fs = {
      ...vault.fs,
      createNote: async (args: { path: VaultPath; contents: string }) => {
        created.push(args);
        return 0;
      },
    };
    const view = await showView({ vault: { ...vault, fs }, editors: fakeEditors(true).registry });
    act(() => view.result.current.setFilters([NOT_DONE]));

    let path: VaultPath | null = null;
    await act(async () => {
      path = await view.result.current.saveAs('Open work');
    });

    expect(path).toBe('.atlas/views/Open work.md');
    expect(created[0]?.contents).toContain('operator: isNot');
    expect(created[0]?.contents).toContain('groupBy: status');
    expect(view.result.current.edited).toBe(false);
    expect(view.result.current.query?.filters).toEqual([]);
  });

  it('refuses a name another view has, and keeps the changes', async () => {
    const view = await showView({ vault: fakeVault(), editors: fakeEditors(true).registry });
    act(() => view.result.current.setFilters([NOT_DONE]));
    await act(async () => {
      await view.result.current.saveAs('board');
    });
    expect(view.result.current.saveAsError).toMatch(/already a view called/);
    expect(view.result.current.edited).toBe(true);
  });

  it('records a new view it could not write, once, and nothing for a name refused', async () => {
    const vault = fakeVault();
    const fs = {
      ...vault.fs,
      createNote: async () => {
        throw new Error('The disk is full.');
      },
    };
    const activity = recordingActivity();
    const view = await showView({
      vault: { ...vault, fs },
      editors: fakeEditors(true).registry,
      activity,
    });
    act(() => view.result.current.setFilters([NOT_DONE]));
    await act(async () => {
      await view.result.current.saveAs('board');
    });
    expect(view.result.current.saveAsError).toMatch(/already a view called/);
    expect(activity.reports).toEqual([]);

    await act(async () => {
      await view.result.current.saveAs('Open work');
    });
    expect(view.result.current.saveAsError).toBe('The disk is full.');
    expect(activity.reports).toEqual([
      {
        level: 'error',
        kind: 'save',
        message: 'Could not save the view. The disk is full.',
        subject: null,
      },
    ]);
  });

  it('records nothing for a new view written', async () => {
    const vault = fakeVault();
    const fs = { ...vault.fs, createNote: async () => 0 };
    const activity = recordingActivity();
    const view = await showView({
      vault: { ...vault, fs },
      editors: fakeEditors(true).registry,
      activity,
    });
    act(() => view.result.current.setFilters([NOT_DONE]));
    await act(async () => {
      await view.result.current.saveAs('Open work');
    });
    expect(view.result.current.edited).toBe(false);
    expect(activity.reports).toEqual([]);
  });

  it('knows the type it lists', async () => {
    const vault = fakeVault();
    const view = await showView({ vault, editors: fakeEditors(true).registry });
    expect(view.result.current.type?.label).toBe('Task');
  });
});

describe('a view adding a note of its type', () => {
  it('makes one in the board’s first column and says where it is', async () => {
    const created: { path: string; contents: string }[] = [];
    const vault = fakeVault();
    const fs = {
      ...vault.fs,
      createNote: async (args: { path: VaultPath; contents: string }) => {
        created.push(args);
        return 0;
      },
    };
    const onChanged = vi.fn();
    const view = await showView({
      vault: { ...vault, fs },
      editors: fakeEditors(true).registry,
      onChanged,
    });

    let path: VaultPath | null = null;
    await act(async () => {
      path = await view.result.current.addNote();
    });

    expect(path).toBe(`${taskHome()}/New task.md`);
    expect(created).toHaveLength(1);
    expect(created[0]?.contents).toContain('type: task');
    expect(created[0]?.contents).toContain('status: backlog');
    expect(onChanged).toHaveBeenCalled();
  });

  it('makes one on a calendar day, at the time it was added at', async () => {
    const created: { path: string; contents: string }[] = [];
    const vault = fakeVault();
    const fs = {
      ...vault.fs,
      createNote: async (args: { path: VaultPath; contents: string }) => {
        created.push(args);
        return 0;
      },
    };
    const view = await showView({ vault: { ...vault, fs }, editors: fakeEditors(true).registry });

    await act(async () => {
      view.result.current.addOnDate({ value: '2026-09-22T14:30', name: 'Standup' });
      await settle();
    });

    // A due day is not the note's `date`, so it is filed by the day it was made.
    expect(created.map((note) => note.path)).toEqual([`${taskHome()}/Standup.md`]);
    expect(created[0]?.contents).toMatch(/due: '?2026-09-22T14:30'?/);
    expect(created[0]?.contents).toContain('type: task');
    // Not filed in a board column: it was added on a day, not in a column.
    expect(created[0]?.contents).not.toContain('status:');
  });

  it('says nothing was made, and shows why, when the create fails', async () => {
    const vault = fakeVault();
    const fs = {
      ...vault.fs,
      createNote: async () => {
        throw new Error('disk full');
      },
    };
    const view = await showView({ vault: { ...vault, fs }, editors: fakeEditors(true).registry });

    let path: VaultPath | null = createVaultPath('unset.md');
    await act(async () => {
      path = await view.result.current.addNote();
    });

    expect(path).toBeNull();
    expect(view.result.current.error).toBe('disk full');
  });
});

/** An index whose one task is in `doing`, built once for the same reason as INDEX. */
const INDEX_WITH_TASK = fakeIndexPort({
  query: async () => ({
    columns: ['path', 'title', 'summary', 'status'],
    rows: [[TASK_PATH, 'First', '', 'doing']],
    truncated: false,
  }),
});

/** What a write asked for, with a rule run against the note's current properties. */
const valuesOf = (write: { values: unknown } | undefined, properties = {}) =>
  typeof write?.values === 'function' ? write.values(properties) : write?.values;

describe('ticking a note done', () => {
  it('sets the done option through the pane, and unticking puts back what it was', async () => {
    const vault = fakeVault();
    const { registry, asked } = fakeEditors(true);
    const view = await showView({ vault, editors: registry, index: INDEX_WITH_TASK });
    await waitFor(() => expect(view.result.current.rows).toHaveLength(1));
    const ticks = view.result.current.ticks;
    if (ticks === undefined) throw new Error('a task with a done option should draw boxes');

    expect(ticks.isDone({ status: 'doing' })).toBe(false);
    expect(ticks.isDone({ status: 'done' })).toBe(true);

    act(() => ticks.onToggle({ path: TASK_PATH, done: true }));
    act(() => ticks.onToggle({ path: TASK_PATH, done: false }));
    await settle();

    expect(asked.map((write) => write.path)).toEqual([TASK_PATH, TASK_PATH]);
    expect(valuesOf(asked[0], { status: 'doing' })).toEqual({ status: 'done' });
    expect(valuesOf(asked[1])).toEqual({ status: 'doing' });
    expect(vault.written).toEqual([]);
  });

  it('unticks to the first option when this session never saw the note ticked', async () => {
    const { registry, asked } = fakeEditors(true);
    const view = await showView({ vault: fakeVault(), editors: registry, index: INDEX_WITH_TASK });
    await waitFor(() => expect(view.result.current.rows).toHaveLength(1));

    act(() => view.result.current.ticks?.onToggle({ path: TASK_PATH, done: false }));
    await settle();

    expect(valuesOf(asked[0])).toEqual({ status: 'backlog' });
  });

  it('remembers across views: the memory is the session’s, not the pane’s', async () => {
    const tickMemory = createTickMemory();
    const first = fakeEditors(true);
    const ticking = await showView({
      vault: fakeVault(),
      editors: first.registry,
      index: INDEX_WITH_TASK,
      tickMemory,
    });
    await waitFor(() => expect(ticking.result.current.rows).toHaveLength(1));
    act(() => ticking.result.current.ticks?.onToggle({ path: TASK_PATH, done: true }));
    ticking.unmount();

    const second = fakeEditors(true);
    const unticking = await showView({
      vault: fakeVault(),
      editors: second.registry,
      index: INDEX_WITH_TASK,
      tickMemory,
    });
    await waitFor(() => expect(unticking.result.current.rows).toHaveLength(1));
    act(() => unticking.result.current.ticks?.onToggle({ path: TASK_PATH, done: false }));
    await settle();

    expect(valuesOf(second.asked[0])).toEqual({ status: 'doing' });
  });
});

describe('choosing a calendar’s range', () => {
  it('draws it at once, and writes it as calendarRange only when the view is saved', async () => {
    const { registry, asked } = fakeEditors(true);
    const view = await showView({ vault: fakeVault(), editors: registry });
    expect(view.result.current.display.calendarRange).toBe('month');

    act(() => view.result.current.setCalendarRange('week'));
    await settle();
    expect(view.result.current.display.calendarRange).toBe('week');
    expect(view.result.current.edited).toBe(true);
    expect(asked).toEqual([]);

    act(() => view.result.current.save());
    await settle();
    expect(asked).toEqual([{ path: VIEW_PATH, values: { calendarRange: 'week' } }]);
  });

  it('puts the range back on Reset', async () => {
    const view = await showView({ vault: fakeVault(), editors: fakeEditors(true).registry });
    act(() => view.result.current.setCalendarRange('agenda'));
    act(() => view.result.current.reset());
    expect(view.result.current.display.calendarRange).toBe('month');
    expect(view.result.current.edited).toBe(false);
  });
});

describe('switching a view’s layout', () => {
  it('draws the new layout at once, and writes it only when the view is saved', async () => {
    const { registry, asked } = fakeEditors(true);
    const view = await showView({ vault: fakeVault(), editors: registry });

    act(() => view.result.current.setLayout('feed'));
    await settle();
    expect(view.result.current.display.layout).toBe('feed');
    expect(view.result.current.edited).toBe(true);
    expect(asked).toEqual([]);

    act(() => view.result.current.save());
    await settle();
    expect(asked).toEqual([{ path: VIEW_PATH, values: { layout: 'feed' } }]);
  });

  it('puts the layout back on Reset, like any other unsaved change', async () => {
    const view = await showView({ vault: fakeVault(), editors: fakeEditors(true).registry });
    act(() => view.result.current.setLayout('list'));
    expect(view.result.current.display.layout).toBe('list');

    act(() => view.result.current.reset());
    expect(view.result.current.display.layout).toBe('board');
    expect(view.result.current.edited).toBe(false);
  });

  it('is no longer edited once the layout is chosen back', async () => {
    const view = await showView({ vault: fakeVault(), editors: fakeEditors(true).registry });
    act(() => view.result.current.setLayout('gallery'));
    act(() => view.result.current.setLayout('board'));
    expect(view.result.current.edited).toBe(false);
  });

  it('writes nothing for a layout the type cannot draw', async () => {
    const { registry, asked } = fakeEditors(true);
    const view = await showView({ vault: fakeVault(), editors: registry });
    // The task type here has a status and no date.
    const calendar = view.result.current.layouts.find((choice) => choice.layout === 'calendar');
    expect(calendar?.available).toBe(false);

    act(() => view.result.current.setLayout('calendar'));
    await settle();

    expect(view.result.current.display.layout).toBe('board');
    expect(view.result.current.edited).toBe(false);
    expect(asked).toEqual([]);
  });
});
