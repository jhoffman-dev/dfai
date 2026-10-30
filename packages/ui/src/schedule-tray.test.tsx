// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BoardRow, TaskSchedule, TrayTask } from '@dfai/domain';
import { shown } from './calendar-test-support.ts';
import { CalendarView } from './calendar-view.tsx';
import { announced, layOut, type Box } from './drag/test-layout.ts';
import type { Planner } from './schedule-tray.tsx';

/** P31-02: the tray of next actions beside a calendar of blocks, and placing them. */
const schedule = (scheduled: number, estimate: number | null): TaskSchedule => ({
  estimate,
  scheduled,
  done: estimate === null ? null : 0,
  overBy: estimate === null ? 0 : Math.max(0, scheduled - estimate),
});

const REPORT: TrayTask = {
  path: 'Quarterly report.md',
  title: 'Quarterly report',
  schedule: schedule(0, 120),
  chosen: false,
};
const CALL: TrayTask = {
  path: 'Call Mara.md',
  title: 'Call Mara',
  schedule: schedule(0, null),
  chosen: false,
};
const INVOICE: TrayTask = {
  path: 'Invoice Larkspur.md',
  title: 'Invoice Larkspur',
  schedule: schedule(60, 90),
  chosen: false,
};

const blocks: BoardRow[] = [
  {
    path: 'Admin.md',
    title: 'Admin',
    values: { start: '2026-10-12T13:00', end: '2026-10-12T14:00' },
  },
];

function planner(overrides: Partial<Planner> = {}): Planner {
  return {
    tasks: [REPORT, CALL, INVOICE],
    problem: null,
    place: vi.fn(),
    undo: null,
    ...overrides,
  };
}

const props = {
  rows: blocks,
  dateKey: 'start',
  endKey: 'end',
  calendar: shown('week', '2026-10-12'),
  today: '2026-10-12',
  now: null,
  onOpenNote: vi.fn(),
  onReschedule: vi.fn(),
  onCreate: vi.fn(),
};

const tray = () => screen.getByRole('complementary', { name: 'Next actions to plan' });
const task = (title: string) =>
  within(tray()).getByRole('button', { name: new RegExp(`^${title}`) });
const column = (date: string) => screen.getByRole('group', { name: date });

describe('the tray beside the week', () => {
  it('lists the next actions as given, each with what is scheduled of its estimate', () => {
    render(<CalendarView {...props} planner={planner()} />);

    const items = within(tray()).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Quarterly report0m of 2h scheduled',
      'Call MaraNo estimate',
      'Invoice Larkspur1h of 1h 30m scheduled',
    ]);
  });

  it('marks a task chosen for today, and only that one (#108)', () => {
    render(
      <CalendarView {...props} planner={planner({ tasks: [{ ...CALL, chosen: true }, REPORT] })} />,
    );

    const items = within(tray()).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Call MaraChosen for todayNo estimate',
      'Quarterly report0m of 2h scheduled',
    ]);
  });

  it('stands beside a week, three days or a day, and not a month or an agenda', () => {
    const { rerender } = render(<CalendarView {...props} planner={planner()} />);
    expect(tray()).toBeDefined();

    for (const range of ['3day', 'day'] as const) {
      rerender(
        <CalendarView {...props} calendar={shown(range, '2026-10-12')} planner={planner()} />,
      );
      expect(tray()).toBeDefined();
    }
    for (const range of ['month', 'agenda'] as const) {
      rerender(
        <CalendarView {...props} calendar={shown(range, '2026-10-12')} planner={planner()} />,
      );
      expect(screen.queryByRole('complementary', { name: 'Next actions to plan' })).toBeNull();
    }
  });

  it('is not there on a calendar with no planner', () => {
    render(<CalendarView {...props} />);
    expect(document.querySelector('.clock__column')).not.toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Next actions to plan' })).toBeNull();
  });

  it('says when nothing is waiting, and why it could not be read', () => {
    render(
      <CalendarView {...props} planner={planner({ tasks: [], problem: 'The index is busy' })} />,
    );
    expect(within(tray()).getByText('Nothing is waiting as a next action.')).toBeDefined();
    expect(within(tray()).getByRole('alert').textContent).toBe('The index is busy');
  });

  it('offers the last drop to undo, and undoes it', () => {
    const run = vi.fn();
    render(
      <CalendarView
        {...props}
        planner={planner({ undo: { said: 'Planned Call Mara in Call Mara block.', run } })}
      />,
    );

    expect(within(tray()).getByRole('status').textContent).toContain(
      'Planned Call Mara in Call Mara block.',
    );
    fireEvent.click(within(tray()).getByRole('button', { name: 'Undo' }));
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('placing a task from the keyboard', () => {
  it('chooses the task, goes to today’s first hour, and places it at the hour Enter is pressed on', async () => {
    const plan = planner();
    render(<CalendarView {...props} planner={plan} />);

    task('Quarterly report').focus();
    await userEvent.keyboard('{Enter}');

    expect(task('Quarterly report').getAttribute('aria-pressed')).toBe('true');
    const nine = within(column('2026-10-12')).getByRole('button', {
      name: 'Plan Quarterly report at 09:00 on Monday 12 October 2026',
    });
    expect(document.activeElement).toBe(nine);
    expect(within(tray()).getByRole('status').textContent).toContain(
      'Choose where Quarterly report goes',
    );

    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(plan.place).toHaveBeenCalledExactlyOnceWith({
      kind: 'time',
      task: REPORT,
      date: '2026-10-12',
      minutes: 11 * 60,
    });
    expect(task('Quarterly report').getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(task('Quarterly report'));
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it('places it in a block with Enter on the block, which is not opened', async () => {
    const plan = planner();
    const onOpenNote = vi.fn();
    render(<CalendarView {...props} onOpenNote={onOpenNote} planner={plan} />);

    task('Call Mara').focus();
    await userEvent.keyboard('{Enter}');
    const admin = screen.getByRole('button', { name: 'Plan Call Mara in Admin' });
    admin.focus();
    await userEvent.keyboard('{Enter}');

    expect(plan.place).toHaveBeenCalledExactlyOnceWith({
      kind: 'block',
      task: CALL,
      block: 'Admin.md',
    });
    expect(onOpenNote).not.toHaveBeenCalled();
  });

  it('lets the task go with Escape: nothing is placed, and the hours add notes again', async () => {
    const plan = planner();
    const onCreate = vi.fn();
    const calendar = shown('week', '2026-10-12');
    render(<CalendarView {...props} calendar={calendar} onCreate={onCreate} planner={plan} />);

    task('Quarterly report').focus();
    await userEvent.keyboard('{Enter}{ArrowDown}{Escape}');

    expect(plan.place).not.toHaveBeenCalled();
    expect(task('Quarterly report').getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(task('Quarterly report'));
    expect(
      within(column('2026-10-12')).getByRole('button', {
        name: 'Add at 09:00 on Monday 12 October 2026',
      }),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: /^Admin/ })).toBeDefined();
  });

  it('chooses with Space too, which picks up no drag: the clock is where it is placed', async () => {
    render(<CalendarView {...props} planner={planner()} />);

    task('Call Mara').focus();
    await userEvent.keyboard(' ');

    expect(task('Call Mara').getAttribute('aria-pressed')).toBe('true');
    expect(announced()).not.toContain('Picked up');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Plan Call Mara at 09:00 on Monday 12 October 2026',
    );
  });

  it('lets the task go when its button is pressed again', async () => {
    render(<CalendarView {...props} planner={planner()} />);
    fireEvent.click(task('Quarterly report'));
    expect(task('Quarterly report').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(task('Quarterly report'));
    expect(task('Quarterly report').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('adversarial (P31-02): placing from the keyboard', () => {
  it('places a chosen task in a block drawn all day with Enter, as in any block, rather than opening it', async () => {
    const plan = planner();
    const onOpenNote = vi.fn();
    const allDay: BoardRow = {
      path: 'Offsite.md',
      title: 'Offsite',
      values: { start: '2026-10-13', end: '2026-10-13' },
    };
    render(
      <CalendarView {...props} rows={[...blocks, allDay]} onOpenNote={onOpenNote} planner={plan} />,
    );

    task('Call Mara').focus();
    await userEvent.keyboard('{Enter}');
    const offsite = within(screen.getByRole('group', { name: 'All day 2026-10-13' })).getByRole(
      'button',
      { name: /Offsite/ },
    );
    offsite.focus();
    await userEvent.keyboard('{Enter}');

    expect(onOpenNote).not.toHaveBeenCalled();
    expect(plan.place).toHaveBeenCalledExactlyOnceWith({
      kind: 'block',
      task: CALL,
      block: 'Offsite.md',
    });
  });

  it('names an all-day block by what Enter does there while a task is chosen', async () => {
    const allDay: BoardRow = {
      path: 'Offsite.md',
      title: 'Offsite',
      values: { start: '2026-10-13', end: '2026-10-13' },
    };
    render(<CalendarView {...props} rows={[...blocks, allDay]} planner={planner()} />);

    task('Call Mara').focus();
    await userEvent.keyboard('{Enter}');

    expect(screen.getByRole('button', { name: 'Plan Call Mara in Offsite' })).toBeDefined();
  });

  it('lets a chosen task go once the tray no longer lists it, so it cannot be placed', async () => {
    const plan = planner();
    const view = render(<CalendarView {...props} planner={plan} />);
    task('Quarterly report').focus();
    await userEvent.keyboard('{Enter}');

    // Finished in another pane: the tray reads again without it.
    view.rerender(<CalendarView {...props} planner={{ ...plan, tasks: [CALL, INVOICE] }} />);
    within(column('2026-10-12'))
      .getByRole('button', { name: /at 09:00 on Monday 12 October 2026$/ })
      .focus();
    await userEvent.keyboard('{Enter}');

    expect(plan.place).not.toHaveBeenCalled();
    expect(within(tray()).getByRole('status').textContent).not.toContain('Quarterly report');
  });
});

/** Seven 100px columns from 100px down; the Admin block a box inside Monday's. */
function clockBoxes(element: Element): Box | null {
  if (element.matches('.clock__columns')) return { left: 0, top: 100, width: 700, height: 1152 };
  if (element.matches('.clock__column')) {
    const at = [...document.querySelectorAll('.clock__column')].indexOf(element);
    return { left: at * 100, top: 100, width: 100, height: 1152 };
  }
  if (element.matches('.clock__note'))
    return { left: 10, top: 100 + 13 * 48, width: 80, height: 48 };
  if (element.matches('.plan-tray__task')) return { left: 800, top: 40, width: 200, height: 30 };
  return null;
}

describe('placing a task with a click', () => {
  beforeEach(() => layOut(clockBoxes));
  afterEach(() => vi.restoreAllMocks());

  it('places a chosen task at the quarter hour clicked in, not the nearest', () => {
    const plan = planner();
    render(<CalendarView {...props} planner={plan} />);

    fireEvent.click(task('Invoice Larkspur'));
    // 100px is the column's top; 09:29 is 569 minutes, 455.2px, down.
    fireEvent.click(column('2026-10-13'), { clientY: 100 + 569 * 0.8 });

    expect(plan.place).toHaveBeenCalledExactlyOnceWith({
      kind: 'time',
      task: INVOICE,
      date: '2026-10-13',
      minutes: 9 * 60 + 15,
    });
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('dragging a task with the pointer', () => {
  /** jsdom lays nothing out, so what is under a point is said here, as a browser would. */
  let under: (x: number, y: number) => Element[];

  beforeEach(() => {
    layOut(clockBoxes);
    under = () => [];
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: (x: number, y: number) => under(x, y),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'elementsFromPoint');
  });

  /** Press on the task, travel to `to`, and let go — or press Escape midway. */
  async function drag(title: string, to: { x: number; y: number }, { cancel = false } = {}) {
    const item = task(title).closest('li') as HTMLElement;
    const pointer = { pointerId: 1, isPrimary: true, button: 0 };
    fireEvent.pointerDown(item, { ...pointer, clientX: 900, clientY: 55 });
    await act(async () => {
      fireEvent.pointerMove(document, { ...pointer, clientX: 890, clientY: 60 });
      fireEvent.pointerMove(document, { ...pointer, clientX: to.x, clientY: to.y });
    });
    if (cancel) {
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    }
    await act(async () => {
      fireEvent.pointerUp(document, { ...pointer, clientX: to.x, clientY: to.y });
    });
  }

  it('makes a block on empty time at the quarter hour the pointer is in', async () => {
    const plan = planner();
    render(<CalendarView {...props} planner={plan} />);
    under = () => [column('2026-10-14')];

    // 10:44 is 644 minutes, 515.2px, below the column's top at 100px.
    await drag('Quarterly report', { x: 250, y: 100 + 644 * 0.8 });

    expect(plan.place).toHaveBeenCalledExactlyOnceWith({
      kind: 'time',
      task: REPORT,
      date: '2026-10-14',
      minutes: 10 * 60 + 30,
    });
    await waitFor(() =>
      expect(announced()).toBe(
        'Quarterly report is planned on Wednesday 14 October 2026 at 10:30.',
      ),
    );
  });

  it('lands where the pointer is, though the tray’s list scrolled under the held task', async () => {
    const plan = planner();
    render(<CalendarView {...props} planner={plan} />);
    under = () => [column('2026-10-14')];
    const list = tray().querySelector('.plan-tray__list') as HTMLElement;
    // An overflowing list, as a long tray is: it scrolls under the held task.
    list.style.overflowY = 'auto';
    const item = task('Quarterly report').closest('li') as HTMLElement;
    const pointer = { pointerId: 1, isPrimary: true, button: 0 };

    fireEvent.pointerDown(item, { ...pointer, clientX: 900, clientY: 55 });
    await act(async () => {
      fireEvent.pointerMove(document, { ...pointer, clientX: 890, clientY: 60 });
    });
    await act(async () => {
      list.scrollTop = 400;
      fireEvent.scroll(list);
    });
    // 10:44 is 644 minutes, 515.2px, below the column's top at 100px.
    await act(async () => {
      fireEvent.pointerMove(document, { ...pointer, clientX: 250, clientY: 100 + 644 * 0.8 });
    });
    await act(async () => {
      fireEvent.pointerUp(document, { ...pointer, clientX: 250, clientY: 100 + 644 * 0.8 });
    });

    expect(plan.place).toHaveBeenCalledExactlyOnceWith({
      kind: 'time',
      task: REPORT,
      date: '2026-10-14',
      minutes: 10 * 60 + 30,
    });
  });

  it('plans nothing when let go over another pane’s calendar', async () => {
    const plan = planner();
    const other = planner();
    render(
      <>
        <CalendarView {...props} planner={plan} />
        <CalendarView {...props} planner={other} />
      </>,
    );
    const columns = screen.getAllByRole('group', { name: '2026-10-14' });
    expect(columns).toHaveLength(2);
    under = () => [columns[1] as HTMLElement];
    const firstTray = screen.getAllByRole('complementary', { name: 'Next actions to plan' })[0];
    const item = within(firstTray as HTMLElement)
      .getByRole('button', { name: /^Quarterly report/ })
      .closest('li') as HTMLElement;
    const pointer = { pointerId: 1, isPrimary: true, button: 0 };

    fireEvent.pointerDown(item, { ...pointer, clientX: 900, clientY: 55 });
    await act(async () => {
      fireEvent.pointerMove(document, { ...pointer, clientX: 890, clientY: 60 });
      fireEvent.pointerMove(document, { ...pointer, clientX: 250, clientY: 600 });
    });
    await act(async () => {
      fireEvent.pointerUp(document, { ...pointer, clientX: 250, clientY: 600 });
    });

    expect(plan.place).not.toHaveBeenCalled();
    expect(other.place).not.toHaveBeenCalled();
  });

  it('adds the task to the block it is let go on, which lies over its day', async () => {
    const plan = planner();
    render(<CalendarView {...props} planner={plan} />);
    const admin = document.querySelector('.clock__note[data-path="Admin.md"]') as HTMLElement;
    under = () => [admin.querySelector('.clock__note-title') as Element, column('2026-10-12')];

    await drag('Call Mara', { x: 50, y: 100 + 13 * 48 + 10 });

    expect(plan.place).toHaveBeenCalledExactlyOnceWith({
      kind: 'block',
      task: CALL,
      block: 'Admin.md',
    });
    await waitFor(() => expect(announced()).toBe('Call Mara is planned in Admin.'));
  });

  it('places nothing when let go off the calendar', async () => {
    const plan = planner();
    render(<CalendarView {...props} planner={plan} />);
    under = () => [tray()];

    await drag('Quarterly report', { x: 900, y: 300 });

    expect(plan.place).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(announced()).toBe(
        'Quarterly report was let go off the calendar, so nothing was planned.',
      ),
    );
  });

  it('places nothing when the drag is cancelled midway with Escape', async () => {
    const plan = planner();
    render(<CalendarView {...props} planner={plan} />);
    under = () => [column('2026-10-14')];

    await drag('Quarterly report', { x: 250, y: 600 }, { cancel: true });

    expect(plan.place).not.toHaveBeenCalled();
    await waitFor(() => expect(announced()).toBe('Cancelled. Quarterly report is not planned.'));
  });

  it('leaves a note dragged on the clock to the clock', async () => {
    const plan = planner();
    const onReschedule = vi.fn();
    render(<CalendarView {...props} onReschedule={onReschedule} planner={plan} />);
    under = () => [column('2026-10-13')];

    const admin = document.querySelector('.clock__note[data-path="Admin.md"]') as HTMLElement;
    const pointer = { pointerId: 1, isPrimary: true, button: 0 };
    fireEvent.pointerDown(admin, { ...pointer, clientX: 50, clientY: 730 });
    await act(async () => {
      fireEvent.pointerMove(document, { ...pointer, clientX: 60, clientY: 735 });
      fireEvent.pointerMove(document, { ...pointer, clientX: 150, clientY: 730 });
    });
    await act(async () => {
      fireEvent.pointerUp(document, { ...pointer, clientX: 150, clientY: 730 });
    });

    expect(plan.place).not.toHaveBeenCalled();
    expect(onReschedule).toHaveBeenCalledExactlyOnceWith({
      path: 'Admin.md',
      start: '2026-10-13T13:00',
      end: '2026-10-13T14:00',
    });
  });
});
