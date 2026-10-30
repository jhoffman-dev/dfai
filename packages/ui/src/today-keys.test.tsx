// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, todayLists, type ReviewTask } from '@dfai/domain';
import type { TodayReport } from '@dfai/application';
import { TodayPage, type TodayPageProps } from './today-page.tsx';

/** #109: keyboard triage on Today, on a report the domain made on a fixed clock. */
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
const TITLES = TASKS.map((each) => each.title);

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
    onUndo: vi.fn(),
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
const row = (title: string) => ({ path: createVaultPath(`Tasks/${title}.md`), title });

describe('TodayPage — keyboard triage (#109)', () => {
  it('moves the focus a row with J, K and the arrows, across sections, staying put at either end', async () => {
    page();
    // The page's order, which the keys walk: one section to the next.
    focusRow('Send the figures');
    for (const title of TITLES.slice(1)) {
      await userEvent.keyboard('j');
      expect(document.activeElement).toBe(handle(title));
    }
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(handle('Quote from Tobias'));
    await userEvent.keyboard('k{ArrowUp}');
    expect(document.activeElement).toBe(handle('Ship the page'));
    focusRow('Send the figures');
    await userEvent.keyboard('k');
    expect(document.activeElement).toBe(handle('Send the figures'));
  });

  it('opens the row’s note on Return; Return on one of its buttons presses that button instead', async () => {
    const { onOpen, onDefer } = page();
    focusRow('Ship the page');
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith('Tasks/Ship the page.md');

    act(() => screen.getByRole('button', { name: 'Defer Ship the page 1 day' }).focus());
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onDefer).toHaveBeenCalledTimes(1);
  });

  it('ticks done on X, defers a day on D and chooses for today on T', async () => {
    const { onDone, onDefer, onChoose } = page();
    focusRow('Ship the page');
    await userEvent.keyboard('x');
    expect(onDone).toHaveBeenCalledWith(row('Ship the page'));
    focusRow('Write the guide');
    await userEvent.keyboard('d');
    expect(onDefer).toHaveBeenCalledWith({ ...row('Write the guide'), days: 1 });
    focusRow('Draft the plan');
    await userEvent.keyboard('t');
    expect(onChoose).toHaveBeenCalledWith({ ...row('Draft the plan'), choice: 'choose' });
  });

  it('sets a status on N, W and S — never the one the task has', async () => {
    const { onSetStatus } = page();
    focusRow('Quote from Tobias');
    await userEvent.keyboard('w');
    expect(onSetStatus).not.toHaveBeenCalled();
    await userEvent.keyboard('n');
    expect(onSetStatus).toHaveBeenCalledWith({
      ...row('Quote from Tobias'),
      status: 'next-action',
    });
    focusRow('Ship the page');
    await userEvent.keyboard('s');
    expect(onSetStatus).toHaveBeenLastCalledWith({ ...row('Ship the page'), status: 'someday' });
  });

  it('opens Move to… on M, and no key fires while its menu has the focus', async () => {
    const { onDone, onSetStatus } = page();
    focusRow('Ship the page');
    await userEvent.keyboard('m');
    const items = await screen.findAllByRole('menuitem');
    const menu = items[0]?.closest('[role="menu"]') as HTMLElement;
    // Opened as Return would open it: its first status has the focus.
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard('xjn');
    expect(onDone).not.toHaveBeenCalled();
    expect(onSetStatus).not.toHaveBeenCalled();
    expect(menu.contains(document.activeElement)).toBe(true);
  });

  it('moves the focus to the next row once the row acted on leaves the page', async () => {
    const view = page();
    focusRow('Ship the page');
    await userEvent.keyboard('x');
    // The page shows the row gone, as the app's read does once it is ticked.
    act(() => view.rerender({ today: without('Ship the page') }));
    expect(document.activeElement).toBe(handle('Write the guide'));
  });

  it('moves the focus to the next row when T sends the row up to Chosen for today (#108)', async () => {
    const view = page();
    focusRow('Ship the page');
    await userEvent.keyboard('t');
    const chosen = TASKS.map((each) =>
      each.title === 'Ship the page' ? { ...each, focus: TODAY } : each,
    );
    act(() => view.rerender({ today: report(chosen) }));
    expect(
      within(screen.getByRole('region', { name: 'Chosen for today' })).getByRole('checkbox', {
        name: 'Mark Ship the page done',
      }),
    ).toBeDefined();
    expect(document.activeElement).toBe(handle('Write the guide'));
  });

  it('takes the last change back on U or ⌘Z, and gives the row it brought back the focus', async () => {
    const view = page();
    focusRow('Ship the page');
    await userEvent.keyboard('x');
    act(() => view.rerender({ today: without('Ship the page') }));
    expect(document.activeElement).toBe(handle('Write the guide'));

    await userEvent.keyboard('u');
    expect(view.onUndo).toHaveBeenCalledTimes(1);
    act(() => view.rerender({ today: report() }));
    expect(document.activeElement).toBe(handle('Ship the page'));

    await userEvent.keyboard('{Meta>}z{/Meta}');
    expect(view.onUndo).toHaveBeenCalledTimes(2);
  });

  it('holds U back while a change is still on its way: the undo on offer is still the one before (PR #641 review)', async () => {
    const view = page({ settling: new Set([createVaultPath('Tasks/Ship the page.md')]) });
    focusRow('Write the guide');
    await userEvent.keyboard('u');
    await userEvent.keyboard('{Meta>}z{/Meta}');
    expect(view.onUndo).not.toHaveBeenCalled();
    view.rerender({ settling: new Set() });
    await userEvent.keyboard('u');
    expect(view.onUndo).toHaveBeenCalledTimes(1);
  });

  it('gives the focus to the row the undo says it took back, not the one last acted on here (PR #641 review)', async () => {
    const onUndo = vi.fn(async () => createVaultPath('Tasks/Call the bank.md'));
    const view = page({ onUndo });
    focusRow('Send the figures');
    await userEvent.keyboard('x');
    act(() => view.rerender({ today: without('Send the figures') }));
    expect(document.activeElement).toBe(handle('Draft the plan'));
    await act(async () => {
      await userEvent.keyboard('u');
    });
    expect(document.activeElement).toBe(handle('Call the bank'));
  });

  it('takes no key on a row whose controls wait, nor while the page is busy', async () => {
    const view = page({ settling: new Set([createVaultPath('Tasks/Ship the page.md')]) });
    act(() => handle('Ship the page').removeAttribute('disabled'));
    focusRow('Ship the page');
    await userEvent.keyboard('xdt');
    view.rerender({ busy: true, settling: new Set() });
    focusRow('Write the guide');
    await userEvent.keyboard('xdt');
    expect(view.onDone).not.toHaveBeenCalled();
    expect(view.onDefer).not.toHaveBeenCalled();
    expect(view.onChoose).not.toHaveBeenCalled();
  });

  it('fires nothing off the rows: a key on the Inbox link is the link’s', async () => {
    const { onDone, onOpen, onOpenInbox } = page();
    act(() => screen.getByRole('button', { name: /^Inbox/ }).focus());
    await userEvent.keyboard('xj');
    expect(onDone).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Inbox/ }));
    await userEvent.keyboard('{Enter}');
    expect(onOpenInbox).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('lists its keys above the sections, read by a screen reader as a note, and names them on the row', () => {
    page();
    const strip = screen.getByRole('note', { name: 'Keys for Today' });
    const hints = [...strip.querySelectorAll('.key-hints__hint')].map((hint) => hint.textContent);
    expect(hints).toEqual([
      'JKMove',
      '↵Open',
      'XDone',
      'TToday',
      'DDefer a day',
      'NWSNext, Waiting, Someday',
      'MMove to…',
      'UUndo',
    ]);
    expect(handle('Ship the page').getAttribute('aria-keyshortcuts')).toBe('x');
    expect(
      screen
        .getByRole('button', { name: 'Defer Ship the page 1 day' })
        .getAttribute('aria-keyshortcuts'),
    ).toBe('d');
  });

  it('works five rows by keys alone: done, defer, past one, a status, a choice — focus moving on each time', async () => {
    const view = page();
    const left: string[] = [];
    const leave = (title: string) => {
      left.push(title);
      act(() => view.rerender({ today: without(...left) }));
    };
    focusRow('Send the figures');
    await userEvent.keyboard('x');
    leave('Send the figures');
    expect(document.activeElement).toBe(handle('Draft the plan'));
    await userEvent.keyboard('d');
    leave('Draft the plan');
    expect(document.activeElement).toBe(handle('Ship the page'));
    await userEvent.keyboard('j');
    await userEvent.keyboard('s');
    leave('Write the guide');
    expect(document.activeElement).toBe(handle('Quote from Tobias'));
    await userEvent.keyboard('t');
    expect(view.onDone).toHaveBeenCalledWith(row('Send the figures'));
    expect(view.onDefer).toHaveBeenCalledWith({ ...row('Draft the plan'), days: 1 });
    expect(view.onSetStatus).toHaveBeenCalledWith({ ...row('Write the guide'), status: 'someday' });
    expect(view.onChoose).toHaveBeenCalledWith({ ...row('Quote from Tobias'), choice: 'choose' });
  });
});
