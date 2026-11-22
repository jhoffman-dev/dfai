// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BoardRow } from '@dfai/domain';
import { shown } from './calendar-test-support.ts';
import { CalendarView } from './calendar-view.tsx';
import type { DoneTicks } from './done-checkbox.tsx';

const TODAY = '2026-09-24';

const rows: BoardRow[] = [
  { path: 'late.md', title: 'Late report', values: { due: '2026-09-20', status: 'doing' } },
  { path: 'finished.md', title: 'Finished', values: { due: '2026-09-21', status: 'done' } },
  { path: 'standup.md', title: 'Standup', values: { due: '2026-09-24T09:00', status: 'next' } },
  { path: 'errand.md', title: 'Errand', values: { due: '2026-09-24', status: 'next' } },
  { path: 'next.md', title: 'Next week', values: { due: '2026-10-01', status: 'next' } },
  { path: 'far.md', title: 'Far off', values: { due: '2026-11-20', status: 'next' } },
];

const ticks = (onToggle = vi.fn()): DoneTicks => ({
  isDone: (values) => values['status'] === 'done',
  onToggle,
});

const props = {
  rows,
  dateKey: 'due',
  calendar: shown('agenda', TODAY),
  today: TODAY,
  fields: ['due', 'status'],
  kinds: { status: 'select' as const },
  onOpenNote: () => {},
  onReschedule: () => {},
};

const rowTitles = (section: HTMLElement) =>
  within(section)
    .getAllByRole('listitem')
    .map((row) => within(row).getByRole('button').textContent);

describe('the agenda', () => {
  it('puts what is past and not done in Overdue, at the top', () => {
    render(<CalendarView {...props} ticks={ticks()} />);
    const overdue = screen.getByRole('region', { name: 'Overdue' });
    expect(rowTitles(overdue)).toEqual(['Late report']);
    expect(overdue.textContent).toContain('Sun, Sep 20, 2026');
    const sections = screen
      .getAllByRole('region')
      .filter((region) => region !== screen.getByRole('region', { name: 'Calendar' }));
    expect(sections[0]).toBe(overdue);
  });

  it('lists today with its notes in the order of the day, all day first', () => {
    render(<CalendarView {...props} ticks={ticks()} />);
    const today = screen.getByRole('region', { name: 'Today, Thu, Sep 24, 2026' });
    expect(rowTitles(today)).toEqual(['Errand', 'Standup']);
    const [errand, standup] = within(today).getAllByRole('listitem');
    expect(errand?.textContent).toContain('All day');
    expect(standup?.textContent).toContain('09:00');
  });

  it('shows the status and chips, and not the date the day heading already says', () => {
    render(<CalendarView {...props} ticks={ticks()} />);
    const row = screen.getByRole('button', { name: 'Standup' }).closest('li') as HTMLElement;
    expect(row.textContent).toContain('Next');
    expect(row.textContent).not.toContain('2026-09-24');
  });

  it('ticks a note done from its box', async () => {
    const onToggle = vi.fn();
    render(<CalendarView {...props} ticks={ticks(onToggle)} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mark Standup done' }));
    expect(onToggle).toHaveBeenCalledWith({ path: 'standup.md', done: true });
  });

  it('lists thirty days, and thirty more on Load more', async () => {
    render(<CalendarView {...props} ticks={ticks()} />);
    expect(screen.getByRole('button', { name: 'Next week' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Far off' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(screen.getByRole('button', { name: 'Far off' })).toBeDefined();
  });

  it('says so when today has nothing on it', () => {
    render(<CalendarView {...props} rows={[]} />);
    const today = screen.getByRole('region', { name: /^Today/ });
    expect(today.textContent).toContain('Nothing scheduled.');
  });

  it('opens a note from its row', async () => {
    const onOpenNote = vi.fn();
    render(<CalendarView {...props} onOpenNote={onOpenNote} />);
    await userEvent.click(screen.getByRole('button', { name: 'Errand' }));
    expect(onOpenNote).toHaveBeenCalledWith('errand.md');
  });

  it('counts every past note overdue, with no boxes, for a type that cannot be ticked done', () => {
    render(<CalendarView {...props} />);
    const overdue = screen.getByRole('region', { name: 'Overdue' });
    expect(rowTitles(overdue)).toEqual(['Late report', 'Finished']);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('the agenda of tasks by their due (#928)', () => {
  it('puts a task due at 09:00 in Overdue by 09:01, as Today does', () => {
    render(<CalendarView {...props} ticks={ticks()} taskDues now={9 * 60 + 1} />);
    expect(rowTitles(screen.getByRole('region', { name: 'Overdue' }))).toEqual([
      'Late report',
      'Standup',
    ]);
  });

  it('leaves it under today at 09:00, and in any calendar not of task dues', () => {
    const { unmount } = render(<CalendarView {...props} ticks={ticks()} taskDues now={9 * 60} />);
    expect(rowTitles(screen.getByRole('region', { name: 'Overdue' }))).toEqual(['Late report']);
    unmount();
    render(<CalendarView {...props} ticks={ticks()} now={12 * 60} />);
    expect(rowTitles(screen.getByRole('region', { name: 'Overdue' }))).toEqual(['Late report']);
  });
});
