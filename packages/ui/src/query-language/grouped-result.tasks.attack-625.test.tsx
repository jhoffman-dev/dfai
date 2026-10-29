// @vitest-environment jsdom
/**
 * Attack on PR #625 (#107): task rows driven from the keyboard alone — a held
 * row's controls pressed with Space and Enter, Tab through a long virtualised
 * table, and the focus when a ticked row leaves a view filtered on status.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BoardRow, ViewLayout } from '@dfai/domain';
import { GroupedResult } from './grouped-result.tsx';
import type { TaskRowControls, TaskRowShown } from './task-row-controls.tsx';

const row = (title: string): BoardRow => ({
  path: `Tasks/${title}.md`,
  title,
  values: { type: 'task', status: 'next-action' },
});
const [FEED, MEND, SOW] = ['Feed the hens', 'Mend the fence', 'Sow the beans'].map(row) as [
  BoardRow,
  BoardRow,
  BoardRow,
];

const shown = (more: Partial<TaskRowShown> = {}): TaskRowShown => ({
  done: false,
  moves: ['inbox', 'waiting', 'archive'],
  chosen: false,
  waits: false,
  refusal: null,
  ...more,
});

function controls(of: (row: BoardRow) => TaskRowShown | undefined = () => shown()) {
  return {
    of,
    onDone: vi.fn<TaskRowControls['onDone']>(),
    onMove: vi.fn<TaskRowControls['onMove']>(),
    onToday: vi.fn<TaskRowControls['onToday']>(),
  };
}

const element = (layout: ViewLayout, tasks: TaskRowControls, rows: readonly BoardRow[]) => (
  <GroupedResult
    layout={layout}
    fields={[{ key: 'status', label: 'Status' }]}
    rows={rows}
    groups={[]}
    collapsed={new Set()}
    onToggleGroup={() => {}}
    onOpenNote={() => {}}
    tasks={tasks}
  />
);

describe.each(['list', 'table', 'board'] as const)('a %s of tasks, by keyboard', (layout) => {
  it('asks nothing of a held row pressed with Space or Enter', async () => {
    const tasks = controls(() => shown({ waits: true }));
    render(element(layout, tasks, [FEED]));
    screen.getByRole('checkbox', { name: 'Mark Feed the hens done' }).focus();
    await userEvent.keyboard(' ');
    screen.getByRole('button', { name: 'Choose Feed the hens for today' }).focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    screen.getByRole('button', { name: 'Move Feed the hens to…' }).focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{ArrowDown}');
    expect(tasks.onDone).not.toHaveBeenCalled();
    expect(tasks.onToday).not.toHaveBeenCalled();
    expect(tasks.onMove).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('menuitem')).toEqual([]);
  });

  it('keeps the focus on the held box while the tick is written', () => {
    const tasks = controls();
    const view = render(element(layout, tasks, [FEED, MEND]));
    const box = screen.getByRole('checkbox', { name: 'Mark Feed the hens done' });
    box.focus();
    view.rerender(
      element(
        layout,
        controls(() => shown({ waits: true, done: true })),
        [FEED, MEND],
      ),
    );
    expect(document.activeElement).toBe(
      screen.getByRole('checkbox', { name: 'Mark Feed the hens done' }),
    );
    // jsdom keeps the focus on a disabled control, which a browser does not: held means not disabled.
    expect((document.activeElement as HTMLInputElement).disabled).toBe(false);
  });

  it('moves the focus to the next row when a ticked row leaves the view, not to the page', () => {
    const tasks = controls();
    const view = render(element(layout, tasks, [FEED, MEND, SOW]));
    screen.getByRole('checkbox', { name: 'Mark Mend the fence done' }).focus();
    // Read back: the view is of Next actions, and the ticked task is not one any more.
    view.rerender(element(layout, tasks, [FEED, SOW]));
    expect(document.activeElement).not.toBe(document.body);
    expect(
      document.activeElement?.closest('[role="row"], li, article, [class*="card"]')?.textContent,
    ).toContain('Sow the beans');
  });
});

describe('a long table of tasks, by keyboard', () => {
  it('reaches the next row’s box by Tab from a row’s box, and ticks it with Space', async () => {
    const many = Array.from({ length: 2000 }, (_, index) => row(`Task ${index + 1}`));
    const tasks = controls();
    render(element('table', tasks, many));
    screen.getByRole('checkbox', { name: 'Mark Task 1 done' }).focus();
    for (let presses = 0; presses < 8; presses += 1) {
      if (document.activeElement?.getAttribute('aria-label') === 'Mark Task 2 done') break;
      await userEvent.tab();
    }
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Mark Task 2 done');
    await userEvent.keyboard(' ');
    expect(tasks.onDone).toHaveBeenCalledWith(many[1], true);
  });
});
