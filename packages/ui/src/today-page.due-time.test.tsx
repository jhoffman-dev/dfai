// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createVaultPath, todayLists, type ReviewTask } from '@dfai/domain';
import type { TodayReport } from '@dfai/application';
import { TodayPage, type TodayPageProps } from './today-page.tsx';

/** #928: a due's time beside its day on the Today page, only where it names one. */
const TODAY = '2026-12-04';
const NOW = Date.UTC(2026, 11, 4, 12);

const task = (title: string, fields: Partial<ReviewTask> = {}): ReviewTask => ({
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
  ...fields,
});

const TASKS = [
  task('Call Mara Quill', { due: TODAY, dueTime: '15:30' }),
  task('Pay Larkspur Payroll', { due: TODAY }),
  task('Write to Tobias Fenn', { due: TODAY, dueTime: '09:00' }),
  task('Chase the quote', { due: '2026-12-01', dueTime: '17:45' }),
];

function page() {
  const today = {
    ...todayLists({ tasks: TASKS, projects: [], at: { today: TODAY, now: NOW, time: '12:00' } }),
    today: TODAY,
    time: '12:00',
    choosing: true,
    inbox: { count: 0, toFile: 0, toAnswer: 0, more: false },
    truncated: false,
  } satisfies TodayReport;
  const props: TodayPageProps = {
    today,
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

const section = (name: string) => screen.getByRole('region', { name });
const piecesOf = (name: string) =>
  [...section(name).querySelectorAll('.today__pieces')].map((pieces) => pieces.textContent);

describe('TodayPage, a due with a time (#928)', () => {
  it('shows the time beside Due today, date-only first, then by time', () => {
    page();
    expect(piecesOf('Due today')).toEqual([
      'Next Action·Due today',
      'Next Action·Due today at 15:30',
    ]);
  });

  it('shows an overdue time beside its day, muted, its day still the late part', () => {
    page();
    expect(piecesOf('Overdue')).toEqual([
      'Next Action·Due 2026-12-01 at 17:45',
      'Next Action·Due 2026-12-04 at 09:00',
    ]);
    const time = section('Overdue').querySelector('.today__late .due-time');
    expect(time?.textContent).toBe(' at 17:45');
  });

  it('shows no time for a date-only due', () => {
    page();
    const plain = section('Due today').querySelectorAll('.today__pieces')[0];
    expect(plain?.querySelector('.due-time')).toBeNull();
  });
});
