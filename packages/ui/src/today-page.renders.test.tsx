// @vitest-environment jsdom
/**
 * How much the Today page draws again (#217's measurements): a tick redraws
 * the row ticked, not the hundreds beside it, and a row's Move to… menu is
 * not built until it is opened.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
const path = (title: string) => createVaultPath(`Tasks/${title}.md`);

const task = (title: string): ReviewTask => ({
  path: path(title),
  title,
  status: 'next-action',
  due: null,
  defer: null,
  waitingOn: '',
  contexts: [],
  project: null,
  projectTitle: null,
  modified: NOW,
});

const TITLES = ['Call the bank', 'Send the figures', 'Ship the page', 'Write the guide'];

function report(): TodayReport {
  return {
    ...todayLists({ tasks: TITLES.map(task), projects: [], at: { today: TODAY, now: NOW } }),
    today: TODAY,
    inbox: { count: 0, toFile: 0, toAnswer: 0, more: false },
    truncated: false,
    stalledProjects: 0,
  };
}

/** The same report read again once `gone` has left it: every other task the same object, as the app keeps it. */
function without(read: TodayReport, gone: VaultPath): TodayReport {
  return {
    ...read,
    sections: read.sections.map((section) => {
      const groups = section.groups
        .map((group) => ({ ...group, tasks: group.tasks.filter((each) => each.path !== gone) }))
        .filter((group) => group.tasks.length > 0);
      return {
        ...section,
        groups,
        count: groups.reduce((sum, group) => sum + group.tasks.length, 0),
      };
    }),
  };
}

/** The report with one task chosen for today, as a new object changed at `modified`; the rest kept. */
function chosenIn(read: TodayReport, chosen: VaultPath, modified: number): TodayReport {
  const tasks = read.sections.flatMap((section) => section.groups.flatMap((group) => group.tasks));
  const lists = todayLists({
    tasks: tasks.map((each) => (each.path === chosen ? { ...each, focus: TODAY, modified } : each)),
    projects: [],
    at: { today: TODAY, now: NOW },
  });
  const kept = new Map(tasks.map((each) => [each.path, each]));
  return {
    ...read,
    sections: lists.sections.map((section) => ({
      ...section,
      groups: section.groups.map((group) => ({
        ...group,
        tasks: group.tasks.map((each) =>
          each.path === chosen ? each : (kept.get(each.path) ?? each),
        ),
      })),
    })),
  };
}

/** The page as the app hands it over: every callback made again on each of its renders. */
function props(overrides: Partial<TodayPageProps> = {}): TodayPageProps {
  return {
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
    ...overrides,
  };
}

describe('TodayPage — ticking one row', () => {
  it('draws no row again, through the write and the read after it', async () => {
    const read = report();
    const onDone = vi.fn();
    const view = render(<TodayPage {...props({ today: read, onDone })} />);
    startCountingRenders();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mark Call the bank done' }));
    expect(onDone).toHaveBeenCalledWith({ path: path('Call the bank'), title: 'Call the bank' });

    // The app's renders after a tick: busy while it writes, the row settling, then a read without it.
    view.rerender(<TodayPage {...props({ today: read, busy: true })} />);
    const settling = new Set([path('Call the bank')]);
    view.rerender(<TodayPage {...props({ today: read, settling })} />);
    view.rerender(<TodayPage {...props({ today: without(read, path('Call the bank')) })} />);
    const { renders } = stopCountingRenders();

    expect(screen.queryByRole('checkbox', { name: 'Mark Call the bank done' })).toBeNull();
    expect(screen.getAllByRole('checkbox')).toHaveLength(TITLES.length - 1);
    // No row's cells: the ticked row's controls read that it settles from the
    // page (#247), and the three others are not drawn again at all.
    expect(renders['TaskRow'] ?? 0).toBe(0);
  });

  it('draws only the row chosen for today, through the write and the read after it (#108)', async () => {
    const read = report();
    const onChoose = vi.fn();
    const view = render(<TodayPage {...props({ today: read, onChoose })} />);
    startCountingRenders();
    await userEvent.click(screen.getByRole('button', { name: 'Choose Call the bank for today' }));
    expect(onChoose).toHaveBeenCalledWith({
      path: path('Call the bank'),
      title: 'Call the bank',
      choice: 'choose',
    });

    // Drawn chosen as the click lands, then read back from its file: every other task the same object.
    const pending = chosenIn(read, path('Call the bank'), NOW + 1);
    view.rerender(
      <TodayPage {...props({ today: pending, settling: new Set([path('Call the bank')]) })} />,
    );
    view.rerender(
      <TodayPage {...props({ today: chosenIn(read, path('Call the bank'), NOW + 2) })} />,
    );
    const { renders } = stopCountingRenders();

    const chosen = screen.getByRole('region', { name: 'Chosen for today' });
    expect(within(chosen).getByText('Call the bank')).toBeDefined();
    // The chosen row is drawn once where it lands and once read back; the three others never.
    expect(renders['TaskRow'] ?? 0).toBe(2);
  });

  it('still offers no action on any row while one is under way', () => {
    render(<TodayPage {...props({ busy: true })} />);
    const controls = [
      screen.getByRole('checkbox', { name: 'Mark Ship the page done' }),
      screen.getByRole('button', { name: 'Move Ship the page to…' }),
      screen.getByRole('button', { name: 'Defer Ship the page 1 day' }),
    ];
    expect(controls.map((control) => control.matches(':disabled'))).toEqual([true, true, true]);
  });
});

describe('TodayPage — a row’s Move to… menu', () => {
  it('is not built until it is opened', () => {
    startCountingRenders();
    render(<TodayPage {...props()} />);
    const { renders } = stopCountingRenders();

    expect(screen.getAllByRole('button', { name: /^Move .* to…$/ })).toHaveLength(TITLES.length);
    expect(renders['TaskRow']).toBe(TITLES.length);
    expect(renders['MenuRoot'] ?? 0).toBe(0);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens from the keyboard, moves the task, and hands focus back to its button', async () => {
    const onSetStatus = vi.fn();
    render(<TodayPage {...props({ onSetStatus })} />);
    const trigger = screen.getByRole('button', { name: 'Move Ship the page to…' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    trigger.focus();
    await userEvent.keyboard('{Enter}');

    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toContain('Waiting');
    // Opened from the keyboard on its first press, as on any later one: focus on the first item.
    const [first] = within(menu).getAllByRole('menuitem');
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(first?.textContent).toBe('Inbox');
    // Inbox, Backlog, In Progress, then Waiting.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('Waiting');
    await userEvent.keyboard('{Enter}');

    expect(onSetStatus).toHaveBeenCalledWith({
      path: path('Ship the page'),
      title: 'Ship the page',
      status: 'waiting',
    });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Move Ship the page to…' }),
    );
  });

  it('shuts on Escape, and opens again', async () => {
    render(<TodayPage {...props()} />);
    screen.getByRole('button', { name: 'Move Call the bank to…' }).focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('menu');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    const trigger = screen.getByRole('button', { name: 'Move Call the bank to…' });
    expect(document.activeElement).toBe(trigger);

    await userEvent.click(trigger);
    expect(await screen.findByRole('menu')).toBeDefined();
  });
});
