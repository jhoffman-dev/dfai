// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, todayLists, type ReviewTask } from '@dfai/domain';
import type { TodayReport } from '@dfai/application';
import { TodayPage, type TodayPageProps } from './today-page.tsx';

/** Adversarial pass on PR #641 (#109): Today's keys at the edges, on a report made on a fixed clock. */
const TODAY = '2026-10-13';
const NOW = Date.UTC(2026, 9, 13, 15);
const PROJECT = createVaultPath('Projects/Larkspur Payroll.md');

const task = (title: string, fields: Partial<ReviewTask> = {}): ReviewTask => ({
  path: createVaultPath(`Tasks/${title}.md`),
  title,
  status: 'next-action',
  due: null,
  defer: null,
  waitingOn: '',
  contexts: [],
  project: PROJECT,
  projectTitle: 'Larkspur Payroll',
  modified: NOW,
  ...fields,
});

/** Five rows, top to bottom as the page lists them. */
const TASKS = [
  task('Send the figures', { due: TODAY }),
  task('Draft the plan', { status: 'in-progress' }),
  task('Ship the page'),
  task('Write the guide'),
  task('Quote from Tobias', { status: 'waiting', waitingOn: 'Tobias Fenn', project: null }),
];

function report(tasks: readonly ReviewTask[] = TASKS): TodayReport {
  return {
    ...todayLists({ tasks, projects: [], at: { today: TODAY, now: NOW } }),
    today: TODAY,
    choosing: true,
    inbox: { count: 0, toFile: 0, toAnswer: 0, more: false },
    truncated: false,
    stalledProjects: 0,
  };
}

const without = (...gone: string[]) => report(TASKS.filter((each) => !gone.includes(each.title)));

function page(overrides: Partial<TodayPageProps> = {}) {
  const given: TodayPageProps = {
    today: report(),
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
    onUndo: vi.fn(async () => null),
    ...overrides,
  };
  const view = render(<TodayPage {...given} />);
  return {
    ...given,
    rerender: (next: Partial<TodayPageProps>) => view.rerender(<TodayPage {...given} {...next} />),
  };
}

const handle = (title: string) => screen.getByRole('checkbox', { name: `Mark ${title} done` });
const focusRow = (title: string) => act(() => handle(title).focus());

describe('TodayPage keys — attack PR #641', () => {
  // useFocusOnReturn (row-keys.ts) asks only whether the focus is on the element it was on at U:
  // moved away and back, the person is taken to the row the undo brought back, a read later.
  it.fails(
    'does not pull the focus to a row an undo took back once the person has moved on and come back',
    async () => {
      let listed: (path: ReturnType<typeof createVaultPath>) => void = () => {};
      const onUndo = vi.fn(
        () => new Promise<ReturnType<typeof createVaultPath>>((done) => (listed = done)),
      );
      const view = page({ today: without('Quote from Tobias'), onUndo });
      focusRow('Write the guide');
      await userEvent.keyboard('u');
      await act(async () => listed(createVaultPath('Tasks/Quote from Tobias.md')));
      // The row is not listed yet; the person goes on working, up a row and back down.
      await userEvent.keyboard('k');
      await userEvent.keyboard('j');
      expect(document.activeElement).toBe(handle('Write the guide'));
      // Much later, a read lists it again: the person's place is theirs.
      act(() => view.rerender({ today: report() }));
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Mark Write the guide done');
    },
  );

  // The focus goes to the document with the last row; the keys are asked on rows only.
  it.fails('takes the last change back on U once the row it took was the page’s last', async () => {
    const only = [task('Ship the page')];
    const view = page({
      today: report(only),
      onUndo: vi.fn(async () => createVaultPath('Tasks/Ship the page.md')),
    });
    focusRow('Ship the page');
    await userEvent.keyboard('x');
    act(() => view.rerender({ today: report([]) }));
    await act(async () => {
      await userEvent.keyboard('u');
    });
    expect(view.onUndo).toHaveBeenCalledTimes(1);
  });
});
