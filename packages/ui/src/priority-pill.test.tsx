// @vitest-environment jsdom
/**
 * A task's priority on screen (#913): a pill where tasks are listed — Today,
 * the Inbox, a task table — and a field where it is edited — the properties
 * panel and the Inbox's Clarify row. Nothing is drawn for a task with none.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createVaultPath,
  todayLists,
  type InboxItem,
  type PropertyDef,
  type ReviewTask,
  type TaskPriority,
} from '@dfai/domain';
import { InboxPage, type InboxPageProps } from './inbox-page.tsx';
import { priorityPicker, priorityPill } from './priority-pill.tsx';
import { PropertiesPanel } from './properties-panel.tsx';
import { TableView, type TableResult, type TableSchema } from './table-view.tsx';
import { TodayPage, type TodayPageProps } from './today-page.tsx';

/** What a screen reader is told of any pill: "Priority 1" to "Priority 4". */
const ANY_PRIORITY = /^Priority [1-4]$/;

/** The pill around the words a screen reader is told. */
function pillOf(name: HTMLElement): HTMLElement {
  const pill = name.closest<HTMLElement>('.priority-pill');
  if (pill === null) throw new Error('not in a pill');
  return pill;
}

/** What a pill shows on screen: its words a screen reader is not given twice. */
const shownOn = (pill: HTMLElement) => pill.querySelector('[aria-hidden="true"]')?.textContent;

describe('the priority picker', () => {
  const other = (value: unknown) => priorityPicker(value).choices.at(-1)?.label;

  it('shows a list or a map of the note’s own as compact JSON, never "[object Object]"', () => {
    expect(other([1, 2])).toBe('Other: [1, 2]');
    expect(priorityPicker([2]).choices).toHaveLength(5);
    expect(priorityPicker([2]).selected).toBe('2');
    expect(other({ level: 'high' })).toBe('Other: {"level":"high"}');
    expect(other('  high ')).toBe('Other: high');
    expect(priorityPicker([1, 2]).selected).toBe('other');
  });

  it('offers none and P1 to P4 alone for none or one of the four', () => {
    expect(priorityPicker(null)).toMatchObject({ selected: '' });
    expect(priorityPicker(3).selected).toBe('3');
    expect(priorityPicker(3).choices.map((choice) => choice.label)).toEqual([
      'No priority',
      'P1',
      'P2',
      'P3',
      'P4',
    ]);
  });
});

describe('the priority pill', () => {
  it('shows P1 and reads "Priority 1" to a screen reader, so colour is not the only signal', () => {
    render(<button type="button">{priorityPill(1)}</button>);
    expect(screen.getByRole('button', { name: 'Priority 1' })).toBeDefined();
    const pill = pillOf(screen.getByText('Priority 1'));
    expect(shownOn(pill)).toBe('P1');
    expect(pill.getAttribute('data-hue')).toBe('red');
  });

  it('draws each of the four in its own hue and words', () => {
    const { container } = render(
      <p>{[1, 2, 3, 4].map((priority) => priorityPill(priority, `p${priority}`))}</p>,
    );
    const pills = [...container.querySelectorAll<HTMLElement>('.priority-pill')];
    expect(pills.map(shownOn)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(new Set(pills.map((pill) => pill.getAttribute('data-hue'))).size).toBe(4);
  });

  it('draws nothing for none, or for a value that is no priority', () => {
    for (const none of [null, undefined, '', 0, 5, 'high']) expect(priorityPill(none)).toBeNull();
  });
});

const TODAY = '2026-11-18';
const NOW = Date.UTC(2026, 10, 18, 15);

const todayTask = (title: string, priority?: TaskPriority | null): ReviewTask => ({
  path: createVaultPath(`Tasks/${title}.md`),
  title,
  status: 'next-action',
  due: null,
  defer: null,
  waitingOn: '',
  contexts: [],
  project: null,
  projectTitle: null,
  modified: NOW,
  ...(priority !== undefined && { priority }),
});

function todayPage(tasks: readonly ReviewTask[]) {
  const props: TodayPageProps = {
    today: {
      ...todayLists({ tasks, projects: [], at: { today: TODAY, now: NOW } }),
      today: TODAY,
      choosing: true,
      inbox: { count: 0, toFile: 0, toAnswer: 0, more: false },
      truncated: false,
      stalledProjects: 0,
    },
    error: null,
    busy: false,
    problem: null,
    view: null,
    onOpen: vi.fn(),
    onOpenInbox: vi.fn(),
    onOpenReview: vi.fn(),
    onOpenDailyNote: vi.fn(),
    onDone: vi.fn(),
    onSetStatus: vi.fn(),
    onDefer: vi.fn(),
    onChoose: vi.fn(),
  };
  render(<TodayPage {...props} />);
}

const rowOf = (title: string) => {
  const row = screen.getByRole('button', { name: title }).closest('tr');
  if (row === null) throw new Error(`no row for ${title}`);
  return row;
};

describe('Today', () => {
  it('shows the pill on a task with a priority, and nothing on one without', () => {
    todayPage([todayTask('Call the bank', 2), todayTask('Water the plants', null)]);
    expect(shownOn(pillOf(within(rowOf('Call the bank')).getByText('Priority 2')))).toBe('P2');
    expect(within(rowOf('Water the plants')).queryByText(ANY_PRIORITY)).toBeNull();
  });
});

/** A task on an Inbox row; a priority given as text is one of the note's own, `high`. */
const inboxTask = (priority: TaskPriority | string | null | undefined): InboxItem => ({
  path: createVaultPath('Inbox/Call Mara Quill.md'),
  title: 'Call Mara Quill',
  type: 'task',
  arrivedIn: '',
  importOutcome: null,
  importError: null,
  task: {
    status: 'inbox',
    project: null,
    waitingOn: null,
    waitingOnNames: '',
    defer: null,
    due: null,
    ...(priority !== undefined && {
      priority: typeof priority === 'number' ? priority : null,
      priorityWritten: priority === null ? null : String(priority),
    }),
  },
});

function inbox(item: InboxItem) {
  const onClarify = vi.fn(async () => true);
  const props = {
    contents: { items: [item], truncated: false, total: 1 },
    error: null,
    filing: [],
    people: [],
    onOpen: vi.fn(),
    onShowMore: vi.fn(),
    onClarify,
    busy: false,
    problem: null,
  } as unknown as InboxPageProps;
  render(<InboxPage {...props} />);
  return onClarify;
}

describe('the Inbox', () => {
  it('shows the pill on a task with a priority, and nothing on one without', () => {
    inbox(inboxTask(3));
    expect(shownOn(pillOf(screen.getByText('Priority 3')))).toBe('P3');
  });

  it('draws no pill for a task with none', () => {
    inbox(inboxTask(null));
    expect(screen.getByRole('combobox', { name: 'Priority of Call Mara Quill' })).toBeDefined();
    expect(screen.queryByText(ANY_PRIORITY)).toBeNull();
  });

  it('sets a priority in Clarify, by the keyboard, and saves it with the rest', async () => {
    const user = userEvent.setup();
    const onClarify = inbox(inboxTask(null));
    const field = screen.getByRole('combobox', { name: 'Priority of Call Mara Quill' });
    await user.selectOptions(field, 'P1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClarify).toHaveBeenCalledWith(
      expect.objectContaining({ clarification: { priority: 1 } }),
    );
  });

  it('clears a priority back to none in Clarify', async () => {
    const user = userEvent.setup();
    const onClarify = inbox(inboxTask(2));
    const field = screen.getByRole('combobox', { name: 'Priority of Call Mara Quill' });
    expect((field as HTMLSelectElement).value).toBe('2');
    await user.selectOptions(field, 'No priority');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClarify).toHaveBeenCalledWith(
      expect.objectContaining({ clarification: { priority: null } }),
    );
  });

  it('offers no priority where the vault keeps one of its own, which its read leaves out', () => {
    inbox(inboxTask(undefined));
    expect(screen.getByRole('combobox', { name: 'Status of Call Mara Quill' })).toBeDefined();
    expect(screen.queryByRole('combobox', { name: 'Priority of Call Mara Quill' })).toBeNull();
  });

  it('shows a value of the note’s own as "Other: high", and asks nothing of it until a pick', async () => {
    const user = userEvent.setup();
    const onClarify = inbox(inboxTask('high'));
    const field = screen.getByRole('combobox', {
      name: 'Priority of Call Mara Quill',
    }) as HTMLSelectElement;
    expect(field.selectedOptions[0]?.text).toBe('Other: high');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(field, 'P2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClarify).toHaveBeenCalledWith(
      expect.objectContaining({ clarification: { priority: 2 } }),
    );
  });

  it('takes a value of the note’s own away when none is picked', async () => {
    const user = userEvent.setup();
    const onClarify = inbox(inboxTask('high'));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Priority of Call Mara Quill' }),
      'No priority',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClarify).toHaveBeenCalledWith(
      expect.objectContaining({ clarification: { priority: null } }),
    );
  });

  it('asks nothing of a priority left as it was', () => {
    inbox(inboxTask(2));
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

const PRIORITY: PropertyDef = {
  key: 'priority',
  kind: 'number',
  label: 'Priority',
  required: false,
  options: [],
  target: null,
  many: false,
};

describe('the properties panel', () => {
  const panel = (value: unknown) => {
    const onChange = vi.fn();
    render(
      <PropertiesPanel
        typeName="task"
        rows={[{ def: PRIORITY, value, error: null, editor: 'priority' }]}
        relationChoices={{}}
        onChange={onChange}
      />,
    );
    return onChange;
  };

  it('picks a priority from none and P1 to P4, reached by Tab and chosen by the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = panel(null);
    const field = screen.getByLabelText('Priority') as HTMLSelectElement;
    expect(field.tagName).toBe('SELECT');
    expect([...field.options].map((option) => option.text)).toEqual([
      'No priority',
      'P1',
      'P2',
      'P3',
      'P4',
    ]);
    await user.tab();
    expect(document.activeElement).toBe(field);
    await user.selectOptions(field, 'P2');
    expect(onChange).toHaveBeenLastCalledWith('priority', 2);
  });

  it('takes it away when none is picked', async () => {
    const user = userEvent.setup();
    const onChange = panel(4);
    await user.selectOptions(screen.getByLabelText('Priority'), 'No priority');
    expect(onChange).toHaveBeenLastCalledWith('priority', null);
  });

  it('shows a value of the note’s own as "Other: 7", chosen, and writes nothing until a pick', async () => {
    const user = userEvent.setup();
    const onChange = panel(7);
    const field = screen.getByLabelText('Priority') as HTMLSelectElement;
    expect(field.selectedOptions[0]?.text).toBe('Other: 7');
    expect(onChange).not.toHaveBeenCalled();
    await user.selectOptions(field, 'P3');
    expect(onChange).toHaveBeenLastCalledWith('priority', 3);
  });

  it('picks over a list or a mapping of the note’s own too, with no alert', () => {
    for (const [value, shown] of [
      [[1, 2], 'Other: [1, 2]'],
      [{ level: 'high' }, 'Other: {"level":"high"}'],
    ] as const) {
      const { unmount } = render(
        <PropertiesPanel
          typeName="task"
          rows={[{ def: PRIORITY, value, error: null, editor: 'priority' }]}
          relationChoices={{}}
          onChange={vi.fn()}
        />,
      );
      const field = screen.getByLabelText('Priority') as HTMLSelectElement;
      expect(field.tagName).toBe('SELECT');
      expect(field.selectedOptions[0]?.text).toBe(shown);
      expect(screen.queryByRole('alert')).toBeNull();
      unmount();
    }
  });

  it('shows P3 for a task holding 3, with no alert', () => {
    panel(3);
    expect((screen.getByLabelText('Priority') as HTMLSelectElement).selectedOptions[0]?.text).toBe(
      'P3',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cuts a long value of the note’s own short in "Other: …"', () => {
    panel('x'.repeat(60));
    const field = screen.getByLabelText('Priority') as HTMLSelectElement;
    expect(field.selectedOptions[0]?.text).toBe(`Other: ${'x'.repeat(23)}…`);
  });

  it('is a number field where the caller does not say it is a task’s priority', () => {
    render(
      <PropertiesPanel
        typeName="task"
        rows={[{ def: PRIORITY, value: 2, error: null }]}
        relationChoices={{}}
        onChange={vi.fn()}
      />,
    );
    expect((screen.getByLabelText('Priority') as HTMLInputElement).type).toBe('number');
  });
});

describe('a task table', () => {
  it('draws the priority column as pills, and an empty cell for none', () => {
    const schema: TableSchema = {
      kinds: { priority: 'number' },
      labels: { priority: 'Priority' },
      noun: 'task',
      properties: { priority: PRIORITY },
      ranksPriority: true,
    };
    const result: TableResult = {
      columns: ['path', 'title', 'priority'],
      rows: [
        ['a.md', 'Call the bank', 1],
        ['b.md', 'Water the plants', null],
      ],
      truncated: false,
      sql: '',
    };
    render(
      <TableView
        result={result}
        sorts={[]}
        error={null}
        schema={schema}
        onOpenNote={() => {}}
        onToggleSort={() => {}}
        onEditCell={vi.fn()}
      />,
    );
    // The cell's button is named by the pill it holds, as a screen reader reaches it.
    expect(
      within(rowOf('Call the bank')).getByRole('button', { name: 'Priority 1' }),
    ).toBeDefined();
    expect(within(rowOf('Water the plants')).queryByText(ANY_PRIORITY)).toBeNull();
  });

  it('draws a number where the table’s priority is not a task’s 1 to 4', () => {
    render(
      <TableView
        result={{
          columns: ['path', 'title', 'priority'],
          rows: [['g.md', 'Grow the list', 2]],
          truncated: false,
          sql: '',
        }}
        sorts={[]}
        error={null}
        schema={{
          kinds: { priority: 'number' },
          labels: { priority: 'Priority' },
          noun: 'goal',
          properties: { priority: PRIORITY },
        }}
        onOpenNote={() => {}}
        onToggleSort={() => {}}
      />,
    );
    expect(within(rowOf('Grow the list')).getByText('2')).toBeDefined();
    expect(within(rowOf('Grow the list')).queryByText(ANY_PRIORITY)).toBeNull();
  });
});
