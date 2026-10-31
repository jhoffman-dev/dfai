// @vitest-environment jsdom
/**
 * Shift-click in a table, the app's selection and the table together (#249):
 * a run is chosen in the order the table shows its rows, across its groups,
 * the rows it has not drawn among them; and a Shift-click with nowhere to
 * start from chooses its own row alone, and is where the next run starts.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  groupResultRows,
  parseObjectType,
  toBoardRows,
  viewGroupLevels,
  type RowGroup,
} from '@dfai/domain';
import { TableView, type TableGrouping, type TableResult } from '@dfai/ui';
import { tableRowsMeasured } from '@dfai/ui/testing';
import { useRowSelection } from './use-row-selection.ts';

const TASK = parseObjectType({
  name: 'task',
  properties: { status: { kind: 'select', options: ['backlog', 'doing'] } },
});

/** `count` tasks, every third in Backlog and the rest Doing, so the groups interleave the result. */
function read(count: number): TableResult {
  return {
    columns: ['path', 'title', 'status'],
    rows: Array.from({ length: count }, (_, at) => [
      `t${at}.md`,
      `Task ${at}`,
      at % 3 === 0 ? 'backlog' : 'doing',
    ]),
    truncated: false,
    sql: '',
  };
}

const groupsOf = (result: TableResult): RowGroup[] =>
  groupResultRows({
    rows: toBoardRows(result),
    groups: viewGroupLevels({ type: TASK, groupBy: 'status', subGroupBy: null, sorts: [] }),
  });

function Choosing({ result, grouping }: { result: TableResult; grouping?: TableGrouping }) {
  const choosing = useRowSelection('');
  return (
    <>
      <output aria-label="Chosen">{choosing.chosen.join(' ')}</output>
      <TableView
        result={result}
        sorts={[]}
        error={null}
        onOpenNote={() => {}}
        onToggleSort={() => {}}
        selection={choosing.selection}
        {...(grouping !== undefined && { grouping })}
      />
    </>
  );
}

const box = (title: string) => screen.getByRole('checkbox', { name: `Select ${title}` });
/** What the selection holds, rows the table has not drawn among them. */
const chosen = (): readonly string[] =>
  (screen.getByRole('status', { name: 'Chosen' }).textContent ?? '').split(' ').filter(Boolean);
const sorted = () => [...chosen()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

async function shiftClick(element: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  await user.keyboard('{Shift>}');
  await user.click(element);
  await user.keyboard('{/Shift}');
}

describe('a table’s Shift-click, with the app’s selection', () => {
  tableRowsMeasured();
  it('chooses the run in the order the grouped table shows it, across its groups', async () => {
    const result = read(9);
    const grouping = { groups: groupsOf(result), collapsed: new Set<string>(), onToggle() {} };
    render(<Choosing result={result} grouping={grouping} />);
    // Backlog: 0, 3, 6; then Doing: 1, 2, 4, 5, 7, 8. In the result's order, 6 to 2 is 2–6.
    await userEvent.click(box('Task 6'));
    await shiftClick(box('Task 2'));
    expect(sorted()).toEqual(['t1.md', 't2.md', 't6.md']);
  });

  it('chooses rows the table has not drawn, every one between the ends', async () => {
    const result = read(420);
    const view = render(<Choosing result={result} />);
    await userEvent.click(box('Task 0'));
    // Sorted the other way, Task 0 is now last and far out of the page.
    view.rerender(<Choosing result={{ ...result, rows: [...result.rows].reverse() }} />);
    expect(screen.queryByRole('checkbox', { name: 'Select Task 0' })).toBeNull();
    await shiftClick(box('Task 410'));
    expect(chosen()).toHaveLength(411);
    expect(sorted()[0]).toBe('t0.md');
    expect(sorted().at(-1)).toBe('t410.md');
    expect(chosen()).not.toContain('t411.md');
  });

  it('chooses its own row alone with nothing toggled before, and starts the next run there', async () => {
    render(<Choosing result={read(12)} />);
    await shiftClick(box('Task 4'));
    expect(sorted()).toEqual(['t4.md']);
    await shiftClick(box('Task 6'));
    expect(sorted()).toEqual(['t4.md', 't5.md', 't6.md']);
  });

  it('chooses its own row alone once the row it would start from is filtered out', async () => {
    const result = read(12);
    const view = render(<Choosing result={result} />);
    await userEvent.click(box('Task 2'));
    const filtered = { ...result, rows: result.rows.filter((row) => row[0] !== 't2.md') };
    view.rerender(<Choosing result={filtered} />);
    await shiftClick(box('Task 7'));
    expect(sorted()).toEqual(['t2.md', 't7.md']);
    await shiftClick(box('Task 9'));
    expect(sorted()).toEqual(['t2.md', 't7.md', 't8.md', 't9.md']);
  });
});
