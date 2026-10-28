// @vitest-environment jsdom
/**
 * The Today page with hundreds of tasks (#238): only the groups and rows near
 * what the page shows are in the DOM, every row can still be reached from the
 * keyboard, and the row focus is in outlasts a read of the day.
 *
 * jsdom lays nothing out: `vitest.setup.ts` measures every element 800px
 * tall in an 800px window, so a list places its first row and its overscan.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, todayLists, type ReviewTask, type VaultPath } from '@dfai/domain';
import type { TodayReport } from '@dfai/application';
import { TodayPage, type TodayPageProps } from './today-page.tsx';
import { startCountingRenders, stopCountingRenders } from './testing/render-counter.ts';

// Before React loads, so every commit is handed to the counter.
await vi.hoisted(async () => {
  const { installRenderCounter } = await import('./testing/render-counter.ts');
  installRenderCounter();
});

const TODAY = '2026-10-13';
const NOW = Date.UTC(2026, 9, 13, 15);

/** Numbered to sort as they are listed: the page orders a group's tasks by title. */
const name = (at: number) => `Task ${String(at).padStart(3, '0')}`;

const task = (at: number, project: VaultPath | null = null): ReviewTask => ({
  path: createVaultPath(`Tasks/${name(at)}.md`),
  title: name(at),
  status: 'next-action',
  due: null,
  defer: null,
  waitingOn: '',
  contexts: [],
  project,
  projectTitle: project === null ? null : `Project ${String(at).padStart(3, '0')}`,
  modified: NOW,
});

function report(tasks: readonly ReviewTask[]): TodayReport {
  return {
    ...todayLists({ tasks, projects: [], at: { today: TODAY, now: NOW } }),
    today: TODAY,
    choosing: true,
    inbox: { count: 0, toFile: 0, toAnswer: 0, more: false },
    truncated: false,
    stalledProjects: 0,
  };
}

/** `count` next actions under no project: one group, one table. */
const oneGroup = (count: number) => report(Array.from({ length: count }, (_, at) => task(at)));

/** `count` next actions, each under its own project: a group apiece. */
const ownProjects = (count: number) =>
  report(Array.from({ length: count }, (_, at) => task(at, createVaultPath(`Projects/P${at}.md`))));

/** The same read once `gone` has left it: every other task the same object, as the app keeps it. */
function without(read: TodayReport, gone: VaultPath): TodayReport {
  return {
    ...read,
    sections: read.sections.map((section) => {
      const groups = section.groups
        .map((group) => ({ ...group, tasks: group.tasks.filter((each) => each.path !== gone) }))
        .filter((group) => group.tasks.length > 0);
      return { ...section, groups, count: groups.reduce((sum, g) => sum + g.tasks.length, 0) };
    }),
  };
}

function props(today: TodayReport, overrides: Partial<TodayPageProps> = {}): TodayPageProps {
  return {
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
    ...overrides,
  };
}

const nextActions = () => screen.getByRole('region', { name: 'Next actions' });
const ticks = () => screen.getAllByRole('checkbox', { name: /^Mark Task \d+ done$/ });
/** The row the focus is in, by its place among its table's rows. */
const focusedRow = () => document.activeElement?.closest('tr')?.getAttribute('aria-rowindex');

/** A walk of hundreds of key presses takes seconds on a loaded CI shard. */
const KEYBOARD_WALK_MS = 30_000;

describe('TodayPage — a day of hundreds of tasks (#238)', () => {
  it('puts only a screenful of 500 rows in the page, and says there are 500', () => {
    render(<TodayPage {...props(oneGroup(500))} />);

    const drawn = ticks().length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(30);
    expect(within(nextActions()).getByRole('heading', { level: 2 }).textContent).toContain('500');
    expect(within(nextActions()).getByRole('table').getAttribute('aria-rowcount')).toBe('500');
    expect(ticks()[0]?.closest('tr')?.getAttribute('aria-rowindex')).toBe('1');
  });

  it('puts only a screenful of 300 projects’ groups in the page', () => {
    render(<TodayPage {...props(ownProjects(300))} />);

    const groups = within(nextActions()).getAllByRole('group');
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.length).toBeLessThan(30);
    expect(within(nextActions()).getByRole('heading', { level: 2 }).textContent).toContain('300');
  });

  it(
    'reaches every row with Tab, each placed as the focus comes to it',
    async () => {
      render(<TodayPage {...props(oneGroup(20))} />);
      const placed = ticks().length;
      expect(placed).toBeLessThan(20);

      ticks()[0]?.focus();
      const visited = new Set([focusedRow()]);
      for (let presses = 0; presses < 400 && focusedRow() !== '20'; presses += 1) {
        await userEvent.tab();
        visited.add(focusedRow());
      }

      expect(focusedRow()).toBe('20');
      // Every row on the way, none skipped past the rows first placed.
      expect([...visited].filter((row) => row !== undefined && row !== null)).toHaveLength(20);
      expect(
        document.activeElement?.closest('[data-today-row]')?.getAttribute('data-today-row'),
      ).toBe('Tasks/Task 019.md');
      // Reached without putting every row in the page.
      expect(ticks().length).toBeLessThan(20);
    },
    KEYBOARD_WALK_MS,
  );

  it(
    'reaches the next project’s group with Tab, past the groups placed',
    async () => {
      render(<TodayPage {...props(ownProjects(15))} />);
      const placed = within(nextActions()).getAllByRole('group').length;
      expect(placed).toBeLessThan(15);

      screen.getByRole('checkbox', { name: 'Mark Task 000 done' }).focus();
      const rowNow = () =>
        document.activeElement?.closest('[data-today-row]')?.getAttribute('data-today-row');
      const visited = new Set([rowNow()]);
      for (let presses = 0; presses < 1000; presses += 1) {
        if (document.activeElement?.matches('[aria-label="Mark Task 014 done"]') === true) break;
        await userEvent.tab();
        visited.add(rowNow());
      }

      expect(document.activeElement?.getAttribute('aria-label')).toBe('Mark Task 014 done');
      // Every project's row on the way, none skipped past the groups first placed.
      expect([...visited].filter((row) => typeof row === 'string')).toHaveLength(15);
    },
    KEYBOARD_WALK_MS,
  );

  it(
    'reaches the last row of the group above with Shift+Tab, though the rows between are not placed',
    async () => {
      const under = (project: string, from: number, count: number) =>
        Array.from({ length: count }, (_, at) => ({
          ...task(from + at, createVaultPath(`Projects/${project}.md`)),
          projectTitle: project,
        }));
      render(
        <TodayPage {...props(report([...under('Alder', 0, 30), ...under('Birch', 100, 5)]))} />,
      );
      expect(ticks().length).toBeLessThan(35);

      screen.getByRole('checkbox', { name: 'Mark Task 100 done' }).focus();
      // Past the Birch group's name, to the last control of Alder's last row.
      await userEvent.tab({ shift: true });
      await userEvent.tab({ shift: true });

      expect(
        document.activeElement?.closest('[data-today-row]')?.getAttribute('data-today-row'),
      ).toBe('Tasks/Task 029.md');
    },
    KEYBOARD_WALK_MS,
  );

  it('keeps the focused row in the page when a read puts it far from what is shown', () => {
    const tasks = Array.from({ length: 40 }, (_, at) => task(at));
    const view = render(<TodayPage {...props(report(tasks))} />);
    const box = screen.getByRole('checkbox', { name: 'Mark Task 005 done' });
    box.focus();

    // Read again with thirty more tasks above it: its row is now the 36th.
    const above = Array.from({ length: 30 }, (_, at) => {
      const early = `Early ${String(at).padStart(2, '0')}`;
      return { ...task(at), path: createVaultPath(`Tasks/${early}.md`), title: early };
    });
    view.rerender(<TodayPage {...props(report([...above, ...tasks]))} />);

    expect(document.activeElement).toBe(box);
    expect(focusedRow()).toBe('36');
  });

  it('draws one row for a tick among 500: the one that comes into the page as the ticked one leaves', async () => {
    const read = oneGroup(500);
    const onDone = vi.fn();
    const view = render(<TodayPage {...props(read, { onDone })} />);
    const ticked = createVaultPath('Tasks/Task 003.md');
    startCountingRenders();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mark Task 003 done' }));
    view.rerender(<TodayPage {...props(read, { busy: true })} />);
    view.rerender(<TodayPage {...props(read, { settling: new Set([ticked]) })} />);
    view.rerender(<TodayPage {...props(without(read, ticked))} />);
    const { renders } = stopCountingRenders();

    expect(onDone).toHaveBeenCalledWith({ path: ticked, title: 'Task 003' });
    expect(renders['TaskRow']).toBe(1);
  });
});
