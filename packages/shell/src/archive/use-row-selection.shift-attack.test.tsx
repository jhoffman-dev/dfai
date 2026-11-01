// @vitest-environment jsdom
/**
 * Adversarial probes of a table's Shift-click (#249, PR #255): where the run
 * starts once the choice has been let go of, folded and nested groups,
 * direction, modifiers other than Shift, and Shift+Space in a cell's input.
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
  properties: {
    status: { kind: 'select', options: ['backlog', 'doing'] },
    area: { kind: 'select', options: ['home', 'work'] },
  },
});

/** `count` tasks: every third in Backlog, the rest Doing; even ones at Home, odd ones at Work. */
function read(count: number): TableResult {
  return {
    columns: ['path', 'title', 'status', 'area'],
    rows: Array.from({ length: count }, (_, at) => [
      `t${at}.md`,
      `Task ${at}`,
      at % 3 === 0 ? 'backlog' : 'doing',
      at % 2 === 0 ? 'home' : 'work',
    ]),
    truncated: false,
    sql: '',
  };
}

const groupsOf = (result: TableResult, subGroupBy: string | null = null): RowGroup[] =>
  groupResultRows({
    rows: toBoardRows(result),
    groups: viewGroupLevels({ type: TASK, groupBy: 'status', subGroupBy, sorts: [] }),
  });

function Choosing({
  result,
  grouping,
  resetKey = '',
  onEditCell,
}: {
  result: TableResult;
  grouping?: TableGrouping;
  resetKey?: string;
  onEditCell?: (args: { path: string; column: string; value: string }) => void;
}) {
  const choosing = useRowSelection(resetKey);
  return (
    <>
      <output aria-label="Chosen">{choosing.chosen.join(' ')}</output>
      <button type="button" onClick={choosing.clear}>
        Let go
      </button>
      <button
        type="button"
        onClick={() => choosing.afterBatch({ answered: choosing.chosen, failed: [] })}
      >
        Batch done
      </button>
      <TableView
        result={result}
        sorts={[]}
        error={null}
        onOpenNote={() => {}}
        onToggleSort={() => {}}
        selection={choosing.selection}
        {...(grouping !== undefined && { grouping })}
        {...(onEditCell !== undefined && { onEditCell })}
      />
    </>
  );
}

const box = (title: string) => screen.getByRole('checkbox', { name: `Select ${title}` });
const chosen = (): readonly string[] =>
  (screen.getByRole('status', { name: 'Chosen' }).textContent ?? '').split(' ').filter(Boolean);
const sorted = () => [...chosen()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

/** Clicks `element` with `key` held, by one user so the click sees the key. */
async function clickWith(key: string, element: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  await user.keyboard(`{${key}>}`);
  await user.click(element);
  await user.keyboard(`{/${key}}`);
}
const shiftClick = (element: HTMLElement) => clickWith('Shift', element);

describe('where a Shift-click run starts once the choice is let go of', () => {
  tableRowsMeasured();
  it('chooses its own row alone after the choice was cleared', async () => {
    render(<Choosing result={read(12)} />);
    await userEvent.click(box('Task 2'));
    await userEvent.click(screen.getByRole('button', { name: 'Let go' }));
    expect(chosen()).toEqual([]);
    // Nothing is chosen, so there is nowhere for a run to start from.
    await shiftClick(box('Task 8'));
    expect(sorted()).toEqual(['t8.md']);
  });

  it('chooses its own row alone after select mode or the view was left (resetKey changed)', async () => {
    const view = render(<Choosing result={read(12)} resetKey="Errands:true" />);
    await userEvent.click(box('Task 1'));
    view.rerender(<Choosing result={read(12)} resetKey="Errands:false" />);
    view.rerender(<Choosing result={read(12)} resetKey="Errands:true" />);
    expect(chosen()).toEqual([]);
    await shiftClick(box('Task 5'));
    expect(sorted()).toEqual(['t5.md']);
  });

  it('chooses its own row alone after a batch let go of every row', async () => {
    render(<Choosing result={read(12)} />);
    await userEvent.click(box('Task 0'));
    await userEvent.click(screen.getByRole('button', { name: 'Batch done' }));
    expect(chosen()).toEqual([]);
    await shiftClick(box('Task 3'));
    expect(sorted()).toEqual(['t3.md']);
  });

  it('keeps a chosen row chosen when its Shift-click has nowhere to start from', async () => {
    const result = read(12);
    const view = render(<Choosing result={result} />);
    await userEvent.click(box('Task 4'));
    await userEvent.click(box('Task 2'));
    // The run would start at Task 2, which is now filtered out.
    view.rerender(
      <Choosing result={{ ...result, rows: result.rows.filter((row) => row[0] !== 't2.md') }} />,
    );
    await shiftClick(box('Task 4'));
    // PR #255: "the Shift-click ticks its own row only" — it should not untick it.
    expect(sorted()).toEqual(['t2.md', 't4.md']);
  });
});

describe('a Shift-click run, as the table is drawn', () => {
  tableRowsMeasured();
  it('runs either way round, from the row last clicked', async () => {
    render(<Choosing result={read(12)} />);
    await userEvent.click(box('Task 8'));
    await shiftClick(box('Task 5'));
    expect(sorted()).toEqual(['t5.md', 't6.md', 't7.md', 't8.md']);
  });

  it('leaves out the rows of a folded group in the middle of the run', async () => {
    const result = read(9);
    // Backlog: 0, 3, 6 · Doing: 1, 2, 4, 5, 7, 8; then Backlog folded.
    const grouping = {
      groups: groupsOf(result),
      collapsed: new Set<string>(),
      onToggle() {},
    };
    const view = render(<Choosing result={result} grouping={grouping} />);
    await userEvent.click(box('Task 0'));
    const backlog = grouping.groups.find((group) => group.value === 'backlog');
    if (backlog === undefined) throw new Error('no Backlog group');
    view.rerender(
      <Choosing result={result} grouping={{ ...grouping, collapsed: new Set([backlog.id]) }} />,
    );
    // Task 0's group is folded: the run has nowhere to start, so Task 2 is chosen alone.
    await shiftClick(box('Task 2'));
    expect(sorted()).toEqual(['t0.md', 't2.md']);
  });

  it('runs across nested sub-groups in the order they are drawn', async () => {
    const result = read(12);
    const grouping = {
      groups: groupsOf(result, 'area'),
      collapsed: new Set<string>(),
      onToggle() {},
    };
    render(<Choosing result={result} grouping={grouping} />);
    // Drawn: Backlog/Home 0 6 · Backlog/Work 3 9 · Doing/Home 2 4 8 10 · Doing/Work 1 5 7 11.
    await userEvent.click(box('Task 6'));
    await shiftClick(box('Task 4'));
    expect(sorted()).toEqual(['t2.md', 't3.md', 't4.md', 't6.md', 't9.md']);
  });

  it('runs to the end of a sub-group that is open while its sibling is folded', async () => {
    const result = read(12);
    const groups = groupsOf(result, 'area');
    const backlogWork = groups[0]?.subgroups[1];
    if (backlogWork === undefined) throw new Error('no Backlog/Work sub-group');
    const grouping = { groups, collapsed: new Set([backlogWork.id]), onToggle() {} };
    render(<Choosing result={result} grouping={grouping} />);
    await userEvent.click(box('Task 0'));
    await shiftClick(box('Task 4'));
    // 3 and 9 sit in the folded Backlog/Work, so are not in the run.
    expect(sorted()).toEqual(['t0.md', 't2.md', 't4.md', 't6.md']);
  });
});

describe('a Shift-click among other keys', () => {
  tableRowsMeasured();
  it('toggles one row on a ⌘-click, without a run', async () => {
    render(<Choosing result={read(12)} />);
    await userEvent.click(box('Task 1'));
    await clickWith('Meta', box('Task 5'));
    expect(sorted()).toEqual(['t1.md', 't5.md']);
  });

  it('toggles one row on a Ctrl-click, without a run', async () => {
    render(<Choosing result={read(12)} />);
    await userEvent.click(box('Task 1'));
    await clickWith('Control', box('Task 5'));
    expect(sorted()).toEqual(['t1.md', 't5.md']);
  });

  it('chooses nothing when Shift+Space is typed into a cell being edited', async () => {
    render(<Choosing result={read(6)} onEditCell={() => {}} />);
    await userEvent.click(box('Task 1'));
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: /backlog|doing/ })[3] as HTMLElement);
    const input = screen.getByRole('textbox');
    expect(document.activeElement).toBe(input);
    await user.keyboard('{Shift>} {/Shift}');
    expect(sorted()).toEqual(['t1.md']);
  });
});
