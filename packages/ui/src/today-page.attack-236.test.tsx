// @vitest-environment jsdom
/**
 * Adversarial pass on #236 (Performance 1): the Today page's row memo, its
 * page-wide busy through a `<fieldset disabled>`, and its lazy Move to… menus.
 * Each test is one invariant the speed fixes could have broken.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, todayLists, type ReviewTask } from '@dfai/domain';
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
const ATLAS = createVaultPath('Projects/DFAI.md');
const path = (title: string) => createVaultPath(`Tasks/${title}.md`);

const task = (title: string, fields: Partial<ReviewTask> = {}): ReviewTask => ({
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
  ...fields,
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

const TASKS = [
  task('Renew the licence', {
    status: 'backlog',
    due: '2026-10-10',
    project: ATLAS,
    projectTitle: 'DFAI',
  }),
  task('Call the bank'),
  task('Send the figures'),
];

function props(overrides: Partial<TodayPageProps> = {}): TodayPageProps {
  return {
    today: report(TASKS),
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

/** Seeded so a failure names the same row on every run. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('TodayPage busy (fieldset) — #236', () => {
  it('still opens a task from its title while an action is under way, as before the fieldset', async () => {
    const onOpen = vi.fn();
    render(<TodayPage {...props({ busy: true, onOpen })} />);
    const title = screen.getByRole('button', { name: 'Call the bank' });

    expect(title.matches(':disabled')).toBe(false);
    await userEvent.click(title);
    expect(onOpen).toHaveBeenCalledWith(path('Call the bank'));
  });

  it('still opens a task’s project from its row while an action is under way', () => {
    render(<TodayPage {...props({ busy: true })} />);
    const row = screen.getByText('Renew the licence').closest('tr') as HTMLElement;
    const project = within(row).getByRole('button', { name: 'DFAI' });

    expect(project.matches(':disabled')).toBe(false);
  });
});

describe('TodayPage lazy Move to… menu — #236', () => {
  it('opens on the first Space, as on the first Enter', async () => {
    render(<TodayPage {...props()} />);
    screen.getByRole('button', { name: 'Move Call the bank to…' }).focus();
    await userEvent.keyboard(' ');

    expect(await screen.findByRole('menu')).toBeDefined();
  });

  it('opens on the first ArrowDown, as the built menu’s trigger does', async () => {
    render(<TodayPage {...props()} />);
    screen.getByRole('button', { name: 'Move Call the bank to…' }).focus();
    await userEvent.keyboard('{ArrowDown}');

    expect(await screen.findByRole('menu', {}, { timeout: 500 })).toBeDefined();
  });

  it('puts focus on the same place on the first keyboard open as on a later one', async () => {
    render(<TodayPage {...props()} />);
    const name = 'Move Call the bank to…';
    screen.getByRole('button', { name }).focus();
    await userEvent.keyboard('{Enter}');
    const first = await screen.findByRole('menu');
    await waitFor(() => expect(first.contains(document.activeElement)).toBe(true));
    const focusedFirst = document.activeElement?.textContent ?? null;

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name }));
    await userEvent.keyboard('{Enter}');
    const again = await screen.findByRole('menu');
    await waitFor(() => expect(again.contains(document.activeElement)).toBe(true));

    expect(focusedFirst).toBe(document.activeElement?.textContent ?? null);
  });

  it('keeps its menu open when its row is drawn again for a change that keeps it in place', async () => {
    const view = render(<TodayPage {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Move Call the bank to…' }));
    await screen.findByRole('menu');

    // Read again: the task gained a context, so it is a new object in the same row.
    const changed = TASKS.map((each) =>
      each.title === 'Call the bank' ? { ...each, contexts: ['@phone'] } : each,
    );
    view.rerender(<TodayPage {...props({ today: report(changed) })} />);

    expect(screen.getByText('@phone')).toBeDefined();
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Waiting' })).toBeDefined();
  });

  it('shuts the menu when its task leaves the page while it is open', async () => {
    const view = render(<TodayPage {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Move Call the bank to…' }));
    await screen.findByRole('menu');

    view.rerender(
      <TodayPage
        {...props({ today: report(TASKS.filter((each) => each.title !== 'Call the bank')) })}
      />,
    );

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  // 0.6 s on a Mac, up to 4.3 s on a loaded 4-core CI runner (#648): the default 5 s is too close.
  it('builds a menu only for the rows opened: 12 rows each opened once leave one menu up at most', async () => {
    const many = Array.from({ length: 12 }, (_, at) => task(`Task ${String(at).padStart(2, '0')}`));
    const user = userEvent.setup({ delay: null });
    render(<TodayPage {...props({ today: report(many) })} />);
    for (const each of many) {
      await user.click(screen.getByRole('button', { name: `Move ${each.title} to…` }));
      await screen.findByRole('menu');
      // The one just opened, and none left over from the rows before it.
      expect(screen.getAllByRole('menu')).toHaveLength(1);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    }

    expect(screen.queryAllByRole('menu')).toHaveLength(0);
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
    // Twelve, without userEvent's pauses: under a second, where forty with them took 20 s on a CI shard.
  }, 15_000);
});

describe('TodayPage row memo — #236', () => {
  const many = Array.from({ length: 12 }, (_, at) => task(`Row ${String(at).padStart(2, '0')}`));

  it('ticking any one of N rows, then its read-back, draws no row, and the ticked one waits', async () => {
    const random = seeded(236);
    const picks = Array.from({ length: 5 }, () => many[Math.floor(random() * many.length)]!);
    for (const picked of picks) {
      const read = report(many);
      const onDone = vi.fn();
      const view = render(<TodayPage {...props({ today: read, onDone })} />);
      startCountingRenders();
      await userEvent.click(screen.getByRole('checkbox', { name: `Mark ${picked.title} done` }));
      view.rerender(<TodayPage {...props({ today: read, busy: true })} />);
      view.rerender(<TodayPage {...props({ today: read, settling: new Set([picked.path]) })} />);
      const { renders } = stopCountingRenders();
      // Settling, its own Done waits, though its row was not drawn again for it (#247).
      const waits = screen.getByRole('checkbox', { name: `Mark ${picked.title} done` });
      expect(waits.matches(':disabled, [aria-disabled="true"]')).toBe(true);
      view.unmount();

      expect({ picked: picked.title, rows: renders['TaskRow'] ?? 0 }).toEqual({
        picked: picked.title,
        rows: 0,
      });
    }
  });

  it('calls the latest onDone after the app hands over a new one, not the one first drawn with', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(<TodayPage {...props({ onDone: first })} />);
    view.rerender(<TodayPage {...props({ onDone: latest })} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mark Call the bank done' }));

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith({ path: path('Call the bank'), title: 'Call the bank' });
  });

  it('acts on the task as titled now when only its title changed, though its row was kept', async () => {
    const onDone = vi.fn();
    const view = render(<TodayPage {...props({ onDone })} />);
    const renamed = TASKS.map((each) =>
      each.title === 'Call the bank' ? { ...each, title: 'Ring the bank' } : each,
    );
    act(() => view.rerender(<TodayPage {...props({ onDone, today: report(renamed) })} />));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mark Ring the bank done' }));

    expect(onDone).toHaveBeenCalledWith({ path: path('Call the bank'), title: 'Ring the bank' });
  });
});
