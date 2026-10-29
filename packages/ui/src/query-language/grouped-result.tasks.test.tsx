// @vitest-environment jsdom
/**
 * #107: a query's task rows, in a list, a table or a board, each with a done
 * box, a Move to… menu of GTD's statuses and a Today toggle; a refusal said
 * on the row with Try again. Without the controls a result is look-only.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BoardRow, ViewLayout } from '@dfai/domain';
import { GroupedResult } from './grouped-result.tsx';
import type { TaskRowControls, TaskRowShown } from './task-row-controls.tsx';

const row = (title: string): BoardRow => ({
  path: `Tasks/${title}.md`,
  title,
  values: { type: 'task', status: 'next-action' },
});
const CALL = row('Call Tobias');
const WEED = row('Weed the beds');

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

function draw(
  layout: ViewLayout,
  tasks?: TaskRowControls,
  rows: readonly BoardRow[] = [CALL, WEED],
) {
  return render(
    <GroupedResult
      layout={layout}
      fields={[{ key: 'status', label: 'Status' }]}
      rows={rows}
      groups={[]}
      collapsed={new Set()}
      onToggleGroup={() => {}}
      onOpenNote={() => {}}
      {...(tasks !== undefined && { tasks })}
    />,
  );
}

describe.each(['list', 'table', 'board'] as const)('a %s of tasks', (layout) => {
  it('ticks a row from its done box, by pointer or by Space', async () => {
    const tasks = controls();
    draw(layout, tasks);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mark Call Tobias done' }));
    expect(tasks.onDone).toHaveBeenCalledWith(CALL, true);
    screen.getByRole('checkbox', { name: 'Mark Weed the beds done' }).focus();
    await userEvent.keyboard(' ');
    expect(tasks.onDone).toHaveBeenLastCalledWith(WEED, true);
  });

  it('unticks a finished row', async () => {
    const tasks = controls(() => shown({ done: true }));
    draw(layout, tasks);
    const box = screen.getByRole('checkbox', { name: 'Mark Call Tobias done' });
    expect((box as HTMLInputElement).checked).toBe(true);
    await userEvent.click(box);
    expect(tasks.onDone).toHaveBeenCalledWith(CALL, false);
  });

  it('moves a row to the status picked from its menu, from the keyboard', async () => {
    const tasks = controls();
    draw(layout, tasks);
    screen.getByRole('button', { name: 'Move Call Tobias to…' }).focus();
    await userEvent.keyboard('{Enter}');
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Inbox', 'Waiting', 'Archive']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Waiting' }));
    expect(tasks.onMove).toHaveBeenCalledWith(CALL, 'waiting');
  });

  it('chooses a row for today, and shows Today pressed for one chosen', async () => {
    const tasks = controls((each) => shown({ chosen: each === WEED }));
    draw(layout, tasks);
    const choose = screen.getByRole('button', { name: 'Choose Call Tobias for today' });
    expect(choose.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(choose);
    expect(tasks.onToday).toHaveBeenCalledWith(CALL, false);
    const takeOff = screen.getByRole('button', { name: 'Take Weed the beds off today' });
    expect(takeOff.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(takeOff);
    expect(tasks.onToday).toHaveBeenLastCalledWith(WEED, true);
  });

  it('draws no Today toggle where the task cannot be chosen', () => {
    draw(
      layout,
      controls(() => shown({ chosen: null })),
    );
    expect(screen.getAllByRole('button', { name: /^Move .* to…$/ })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /for today$/ })).toBeNull();
  });

  it('holds a row whose change is being written, and says a refusal on its row with Try again', async () => {
    const retry = vi.fn();
    const tasks = controls((each) =>
      each === CALL
        ? shown({ waits: true })
        : shown({ refusal: { message: 'This task has changed since.', onRetry: retry } }),
    );
    draw(layout, tasks);
    expect(
      (screen.getByRole('checkbox', { name: 'Mark Call Tobias done' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Move Call Tobias to…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Choose Call Tobias for today' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This task has changed since.');
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again: Weed the beds' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('gives a row the result cannot act on no controls, and still opens it', () => {
    draw(
      layout,
      controls((each) => (each === CALL ? shown() : undefined)),
    );
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Weed the beds/ })).toBeDefined();
  });

  it('is look-only without the controls: no box, no menu, no toggle', () => {
    draw(layout);
    expect(screen.getByRole('button', { name: /^Call Tobias/ })).toBeDefined();
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.queryByRole('button', { name: /to…$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /today$/ })).toBeNull();
  });
});

describe('a long table of tasks', () => {
  it('draws the controls only on the rows in its window, and keeps the row count', () => {
    const many = Array.from({ length: 2000 }, (_, index) => row(`Task ${index + 1}`));
    draw('table', controls(), many);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.length).toBeLessThan(100);
    expect(boxes[0]?.getAttribute('aria-label')).toBe('Mark Task 1 done');
    expect(screen.getByRole('table').getAttribute('aria-rowcount')).toBe('2001');
    // The done column leads and the commands trail, each with its heading.
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Done',
      'Name',
      'Status',
      'Actions',
    ]);
  });
});
