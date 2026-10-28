// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, todayLists, type ReviewTask } from '@dfai/domain';
import type { TodayReport } from '@dfai/application';
import { TodayPage, todayActionWords, type TodayPageProps } from './today-page.tsx';

/** #111: the Today page, drawn from a report the domain made on a fixed clock. */
const TODAY = '2026-10-13';
const NOW = Date.UTC(2026, 9, 13, 15);
const DAY = 86_400_000;
const ATLAS = createVaultPath('Projects/DFAI.md');

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

const inAtlas = { project: ATLAS, projectTitle: 'DFAI' };

const TASKS = [
  task('Renew the licence', { status: 'backlog', due: '2026-10-10', ...inAtlas }),
  task('Send the figures', { due: TODAY }),
  task('Book the venue', { status: 'someday', defer: TODAY }),
  task('Draft the plan', { status: 'in-progress', contexts: ['@desk', '@deep'] }),
  task('Ship the page', inAtlas),
  task('Write the guide', inAtlas),
  task('Call the bank'),
  task('Quote from Larkspur', {
    status: 'waiting',
    waitingOn: 'Mara Quill',
    modified: NOW - 4 * DAY,
  }),
];

function report(tasks: readonly ReviewTask[] = TASKS, fields: Partial<TodayReport> = {}) {
  return {
    ...todayLists({ tasks, projects: [], at: { today: TODAY, now: NOW } }),
    today: TODAY,
    inbox: { count: 3, toFile: 2, toAnswer: 1, more: false },
    truncated: false,
    stalledProjects: 2,
    ...fields,
  } satisfies TodayReport;
}

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

function page(overrides: Partial<TodayPageProps> = {}) {
  const given = props(overrides);
  const view = render(<TodayPage {...given} />);
  return {
    ...given,
    rerender: (next: Partial<TodayPageProps>) => view.rerender(<TodayPage {...given} {...next} />),
  };
}

const section = (name: string) => screen.getByRole('region', { name });
const count = (name: string) => section(name).querySelector('.review__heading .review__count');
const path = (title: string) => createVaultPath(`Tasks/${title}.md`);

describe('TodayPage', () => {
  it('shows every section with its tasks and its count in the heading', () => {
    page();
    const expected: Record<string, string[]> = {
      Overdue: ['Renew the licence'],
      'Due today': ['Send the figures'],
      'Back from deferral': ['Book the venue'],
      'In progress': ['Draft the plan'],
      'Next actions': ['Ship the page', 'Write the guide', 'Call the bank'],
      Waiting: ['Quote from Larkspur'],
    };
    for (const [name, titles] of Object.entries(expected)) {
      const shown = [...section(name).querySelectorAll('.table__title')].map(
        (el) => el.textContent,
      );
      expect(shown, name).toEqual(titles);
      expect(count(name)?.textContent, name).toBe(String(titles.length));
    }
    expect(screen.getByText('Tuesday · 8 tasks')).toBeDefined();
  });

  it('says so when a section holds nothing, and counts it as none', () => {
    page({ today: report([]) });
    expect(within(section('Overdue')).getByText('Nothing is late.')).toBeDefined();
    expect(within(section('Next actions')).getByText('No next actions.')).toBeDefined();
    expect(count('Waiting')?.textContent).toBe('0');
    expect(
      screen.getByText('Tuesday · nothing needs you').closest('.page-bar__count'),
    ).not.toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: '2026-10-13' })).toBeDefined();
  });

  it('shows a row’s project, contexts and day', () => {
    page();
    const late = within(section('Overdue'));
    expect(late.getByRole('button', { name: 'DFAI' })).toBeDefined();
    expect(late.getByText('Due 2026-10-10')).toBeDefined();
    expect(late.getByText('Backlog')).toBeDefined();
    expect(section('Due today').querySelector('.today__pieces')?.textContent).toContain(
      'Due today',
    );
    const underWay = within(section('In progress'));
    expect(underWay.getByText('@desk')).toBeDefined();
    expect(underWay.getByText('@deep')).toBeDefined();
  });

  it('joins a row’s metadata on one line, a · between each piece and none before the first', () => {
    page();
    const pieces = section('Overdue').querySelector('.today__pieces') as HTMLElement;
    // Its status, its project and its day: two dots between three pieces.
    expect(pieces.textContent).toBe('Backlog·DFAI·Due 2026-10-10');
    const dots = [...pieces.querySelectorAll('.today__sep')];
    expect(dots).toHaveLength(2);
    expect(dots.every((dot) => dot.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(pieces.firstElementChild?.classList.contains('today__sep')).toBe(false);
    expect(pieces.lastElementChild?.classList.contains('today__sep')).toBe(false);
  });

  it('leaves the metadata line empty, with no dot, for a row that has nothing to say', () => {
    page();
    // Under Next actions the project is the group's name, so an undated,
    // uncontexted task says nothing beside its title.
    const row = within(section('Next actions')).getByText('Call the bank').closest('tr')!;
    const pieces = row.querySelector('.today__pieces') as HTMLElement;
    expect(pieces.textContent).toBe('');
    expect(pieces.querySelector('.today__sep')).toBeNull();
  });

  it('draws no count on a group that holds no tasks', () => {
    const made = report();
    const sections = made.sections.map((item) =>
      item.id === 'nextActions'
        ? {
            ...item,
            groups: [
              ...item.groups,
              { key: 'Projects/Shed.md', label: 'Shed', project: null, tasks: [] },
            ],
          }
        : item,
    );
    page({ today: { ...made, sections } });
    const named = within(section('Next actions')).getByRole('group', { name: 'DFAI' });
    expect(named.querySelector('.review__count')?.textContent).toBe('2');
    const empty = within(section('Next actions')).getByRole('group', { name: 'Shed' });
    expect(empty.querySelector('.review__count')).toBeNull();
  });

  it('groups next actions under their project, with those under none named last', () => {
    page();
    const groups = within(section('Next actions')).getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['DFAI', 'No project']);
    expect(within(groups[0] as HTMLElement).getByText('Ship the page')).toBeDefined();
    expect(within(groups[1] as HTMLElement).getByText('Call the bank')).toBeDefined();
  });

  it('opens a project from its group’s name', async () => {
    const { onOpen } = page();
    await userEvent.click(within(section('Next actions')).getByRole('button', { name: 'DFAI' }));
    expect(onOpen).toHaveBeenCalledWith(ATLAS);
  });

  it('groups waiting tasks by person, says how long each has waited, and from what', () => {
    page();
    const waiting = within(section('Waiting'));
    const group = waiting.getByRole('group', { name: 'Mara Quill' });
    expect(within(group).getByText('4 days since last change')).toBeDefined();
    expect(waiting.getByText(/counted from each task’s last change/)).toBeDefined();
  });

  it.each([
    [0, 'Less than a day since last change'],
    [1, '1 day since last change'],
  ])('words a wait of %i days', (days, words) => {
    const waiting = task('Quote', {
      status: 'waiting',
      waitingOn: 'Mara Quill',
      modified: NOW - days * DAY,
    });
    page({ today: report([waiting]) });
    expect(within(section('Waiting')).getByText(words)).toBeDefined();
  });

  it('names a late Waiting task’s person on its row, where no group does', () => {
    const late = task('Quote', { status: 'waiting', waitingOn: 'Mara Quill', due: '2026-10-01' });
    page({ today: report([late]) });
    expect(within(section('Overdue')).getByText('On Mara Quill')).toBeDefined();
  });

  it('links to the Inbox with its count, and to the weekly review with the stalled projects', async () => {
    const { onOpenInbox, onOpenReview } = page();
    const elsewhere = within(screen.getByRole('navigation', { name: 'Elsewhere' }));
    await userEvent.click(elsewhere.getByRole('button', { name: /^Inbox 3/ }));
    expect(onOpenInbox).toHaveBeenCalledTimes(1);
    await userEvent.click(elsewhere.getByRole('button', { name: /^Stalled projects 2/ }));
    expect(onOpenReview).toHaveBeenCalledTimes(1);
  });

  it('marks an Inbox count the index cut short', () => {
    page({ today: report(TASKS, { inbox: { count: 500, toFile: 500, toAnswer: 0, more: true } }) });
    expect(screen.getByRole('button', { name: /^Inbox 500\+/ })).toBeDefined();
  });

  it('opens today’s note, and names its shortcut', async () => {
    const { onOpenDailyNote } = page();
    const button = screen.getByRole('button', { name: /Open today’s note/ });
    expect(button.getAttribute('title')).toContain('⇧⌘D');
    await userEvent.click(button);
    expect(onOpenDailyNote).toHaveBeenCalledTimes(1);
  });

  it('links to a saved view titled Today only when the vault has one', async () => {
    const onOpenView = vi.fn();
    const { rerender } = page();
    expect(screen.queryByRole('button', { name: /^Open the/ })).toBeNull();
    rerender({ view: { title: 'Today', onOpen: onOpenView } });
    await userEvent.click(screen.getByRole('button', { name: 'Open the “Today” view' }));
    expect(onOpenView).toHaveBeenCalledTimes(1);
  });

  it('still links to the saved view while the page is read, and when the read failed', () => {
    const view = { title: 'Today', onOpen: vi.fn() };
    const { rerender } = page({ today: null, view });
    expect(screen.getByRole('button', { name: 'Open the “Today” view' })).toBeDefined();
    rerender({ today: null, error: 'the index is closed', view });
    expect(screen.getByRole('button', { name: 'Open the “Today” view' })).toBeDefined();
  });

  it('says the day a task back from deferral was put off until', () => {
    const woken = task('Clear the shed', { status: 'backlog', defer: '2026-10-09' });
    page({ today: report([woken]) });
    expect(
      within(section('Back from deferral')).getByText('Deferred until 2026-10-09'),
    ).toBeDefined();
  });

  it('shows a context a task names twice, twice', () => {
    page({ today: report([task('Call', { contexts: ['@phone', '@phone'] })]) });
    expect(within(section('Next actions')).getAllByText('@phone')).toHaveLength(2);
  });

  it('takes no action on a row whose change has not been read back, and leaves the others', () => {
    page({ settling: new Set([path('Call the bank')]) });
    const disabledIn = (title: string) => {
      const row = screen.getByText(title).closest('tr') as HTMLElement;
      return [
        within(row).getByRole('checkbox'),
        within(row).getByRole('button', { name: `Move ${title} to…` }),
        within(row).getByRole('button', { name: `Defer ${title} 1 day` }),
        within(row).getByRole('button', { name: `Defer ${title} 7 days` }),
      ].map((control) => (control as HTMLButtonElement).disabled);
    };
    expect(disabledIn('Call the bank')).toEqual([true, true, true, true]);
    expect(disabledIn('Ship the page')).toEqual([false, false, false, false]);
  });

  it('ticks a task done', async () => {
    const { onDone } = page();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mark Draft the plan done' }));
    expect(onDone).toHaveBeenCalledWith({ path: path('Draft the plan'), title: 'Draft the plan' });
  });

  it('defers a task by a day or by a week', async () => {
    const { onDefer } = page();
    await userEvent.click(screen.getByRole('button', { name: 'Defer Call the bank 1 day' }));
    await userEvent.click(screen.getByRole('button', { name: 'Defer Call the bank 7 days' }));
    const row = { path: path('Call the bank'), title: 'Call the bank' };
    expect(onDefer).toHaveBeenNthCalledWith(1, { ...row, days: 1 });
    expect(onDefer).toHaveBeenNthCalledWith(2, { ...row, days: 7 });
  });

  it('moves a task to any status but its own and Archive', async () => {
    const { onSetStatus } = page();
    await userEvent.click(screen.getByRole('button', { name: 'Move Call the bank to…' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Inbox',
      'Backlog',
      'In Progress',
      'Waiting',
      'Someday',
      'Longterm',
    ]);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Waiting' }));
    expect(onSetStatus).toHaveBeenCalledWith({
      path: path('Call the bank'),
      title: 'Call the bank',
      status: 'waiting',
    });
    await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull());
  });

  it('offers no action while one is under way', () => {
    page({ busy: true });
    const row = screen.getByText('Call the bank').closest('tr') as HTMLElement;
    const controls = [
      within(row).getByRole('checkbox'),
      within(row).getByRole('button', { name: 'Move Call the bank to…' }),
      within(row).getByRole('button', { name: 'Defer Call the bank 1 day' }),
    ];
    // Each of the row's actions waits; its title and project do not (see today-page.attack-236).
    expect(controls.map((control) => control.matches(':disabled'))).toEqual([true, true, true]);
  });

  it('says why an action could not be done', () => {
    page({ problem: 'That task has changed since: read it again.' });
    expect(screen.getByRole('alert').textContent).toBe(
      'That task has changed since: read it again.',
    );
  });

  it.each([
    [{ kind: 'done' } as const, 'Finished “Call the bank”.'],
    [{ kind: 'defer', days: 1 } as const, 'Deferred “Call the bank” by 1 day.'],
    [{ kind: 'defer', days: 7 } as const, 'Deferred “Call the bank” by 7 days.'],
    [{ kind: 'move', status: 'someday' } as const, 'Moved “Call the bank” to Someday.'],
  ])('says what was done, in the words its toast offers to take back (%o)', (action, words) => {
    expect(todayActionWords({ title: 'Call the bank', action })).toBe(words);
  });

  it('draws no undo bar of its own: a change is said in the window’s toasts (#320)', () => {
    page({});
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(document.querySelector('.today__notice')).toBeNull();
  });

  it('shows the read’s failure in place of the sections, and waits while there is none yet', () => {
    const { rerender } = page({ today: null });
    expect(screen.getByRole('status').textContent).toBe('Reading the day…');
    rerender({ today: null, error: 'the index is closed' });
    expect(screen.getByRole('alert').textContent).toBe('the index is closed');
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('says when the index held tasks back', () => {
    page({ today: report(TASKS, { truncated: true }) });
    expect(screen.getByText(/more tasks than the page reads at once/)).toBeDefined();
  });
});

describe('TodayPage, focus', () => {
  const without = (title: string) => report(TASKS.filter((item) => item.title !== title));
  const box = (title: string) => screen.getByRole('checkbox', { name: `Mark ${title} done` });

  it('moves to the row underneath once the row acted on has left', async () => {
    const { rerender } = page();
    await userEvent.click(screen.getByRole('button', { name: 'Defer Draft the plan 1 day' }));
    rerender({ today: without('Draft the plan') });
    expect(document.activeElement).toBe(box('Ship the page'));
  });

  it('moves to the row above when the last row leaves', async () => {
    const { rerender } = page();
    await userEvent.click(box('Quote from Larkspur'));
    rerender({ today: without('Quote from Larkspur') });
    expect(document.activeElement).toBe(box('Call the bank'));
  });

  it('waits for the row to leave: a read that still holds it moves nothing', async () => {
    const { rerender } = page();
    const defer = screen.getByRole('button', { name: 'Defer Draft the plan 1 day' });
    await userEvent.click(defer);
    rerender({ today: report() });
    expect(document.activeElement).toBe(defer);
    rerender({ today: without('Draft the plan') });
    expect(document.activeElement).toBe(box('Ship the page'));
  });

  it('remembers the row across a spell with nothing shown, as while the index is read again', async () => {
    const { rerender } = page();
    await userEvent.click(screen.getByRole('button', { name: 'Defer Draft the plan 1 day' }));
    rerender({ today: null });
    rerender({ today: without('Draft the plan') });
    expect(document.activeElement).toBe(box('Ship the page'));
  });

  it('leaves focus where the person has put it since', async () => {
    const { rerender } = page();
    await userEvent.click(screen.getByRole('button', { name: 'Defer Draft the plan 1 day' }));
    const elsewhere = screen.getByRole('button', { name: /Open today’s note/ });
    elsewhere.focus();
    rerender({ today: without('Draft the plan') });
    expect(document.activeElement).toBe(elsewhere);
  });

  it('moves nothing when the action was refused, even once the page is read again', async () => {
    const { rerender } = page();
    const defer = screen.getByRole('button', { name: 'Defer Draft the plan 1 day' });
    await userEvent.click(defer);
    rerender({ problem: 'refused' });
    rerender({ problem: 'refused', today: report() });
    expect(document.activeElement).toBe(defer);
    // Later the row leaves by other means, focus having gone to the panel: nothing follows it.
    (document.activeElement as HTMLElement).blur();
    rerender({ problem: 'refused', today: without('Draft the plan') });
    expect(document.activeElement).toBe(document.body);
  });

  it('follows the row from the panel, where WebKit leaves focus after a press', async () => {
    const { rerender } = page();
    await userEvent.click(screen.getByRole('button', { name: 'Defer Draft the plan 1 day' }));
    const panel = screen.getByRole('article', { name: 'Today' });
    panel.tabIndex = -1;
    panel.focus();
    rerender({ today: without('Draft the plan') });
    expect(document.activeElement).toBe(box('Ship the page'));
  });

  it('reaches every control of a row with Tab, in order', async () => {
    page({ today: report([task('Call the bank')]) });
    box('Call the bank').focus();
    const reached: (string | null)[] = [];
    for (let presses = 0; presses < 5; presses += 1) {
      await userEvent.tab();
      reached.push(
        document.activeElement?.getAttribute('aria-label') ??
          document.activeElement?.textContent ??
          null,
      );
    }
    expect(reached).toEqual([
      'Call the bank',
      'Choose Call the bank for today',
      'Move Call the bank to…',
      'Defer Call the bank 1 day',
      'Defer Call the bank 7 days',
    ]);
  });
});

describe('TodayPage, chosen for today (#108)', () => {
  const CHOSEN = [
    task('Call the bank', { focus: TODAY }),
    task('Draft the plan', { status: 'in-progress', focus: TODAY }),
    task('Ship the page', { focus: '2026-10-12', ...inAtlas }),
    task('Write the guide', inAtlas),
  ];
  const regionNames = () =>
    screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'));
  const titlesIn = (name: string) =>
    [...section(name).querySelectorAll('.table__title')].map((el) => el.textContent);

  it('leads with Chosen for today, then Carried over, each with its tasks', () => {
    page({ today: report(CHOSEN) });
    expect(regionNames().slice(0, 2)).toEqual(['Chosen for today', 'Carried over']);
    expect(titlesIn('Chosen for today')).toEqual(['Call the bank', 'Draft the plan']);
    expect(titlesIn('Carried over')).toEqual(['Ship the page']);
    expect(titlesIn('Next actions')).toEqual(['Write the guide']);
    expect(within(section('Carried over')).getByText('Chosen for 2026-10-12')).toBeDefined();
    // The chosen rows say their status, as the sections of mixed statuses do.
    expect(within(section('Chosen for today')).getByText('In Progress')).toBeDefined();
  });

  it('draws Carried over only while it holds something, and says when nothing is chosen', () => {
    page();
    expect(regionNames()).toContain('Chosen for today');
    expect(regionNames()).not.toContain('Carried over');
    expect(within(section('Chosen for today')).getByText(/Nothing chosen yet/)).toBeDefined();
  });

  it('chooses a task with its Today button, and takes a chosen one off with the pressed one', async () => {
    const { onChoose } = page({ today: report(CHOSEN) });
    const choose = screen.getByRole('button', { name: 'Choose Write the guide for today' });
    expect(choose.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(choose);
    const takeOff = screen.getByRole('button', { name: 'Take Call the bank off today' });
    expect(takeOff.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(takeOff);
    expect(onChoose).toHaveBeenNthCalledWith(1, {
      path: path('Write the guide'),
      title: 'Write the guide',
      choice: 'choose',
    });
    expect(onChoose).toHaveBeenNthCalledWith(2, {
      path: path('Call the bank'),
      title: 'Call the bank',
      choice: 'unchoose',
    });
  });

  it('keeps or drops one carried over, which has no Today button of its own', async () => {
    const { onChoose } = page({ today: report(CHOSEN) });
    const carried = within(section('Carried over'));
    expect(carried.queryByRole('button', { name: /^(Choose|Take) / })).toBeNull();
    expect(carried.getByRole('button', { name: 'Keep Ship the page for today' })).toBeDefined();
    await userEvent.click(carried.getByRole('button', { name: 'Keep Ship the page for today' }));
    await userEvent.click(carried.getByRole('button', { name: 'Drop Ship the page from today' }));
    const row = { path: path('Ship the page'), title: 'Ship the page' };
    expect(onChoose).toHaveBeenNthCalledWith(1, { ...row, choice: 'keep' });
    expect(onChoose).toHaveBeenNthCalledWith(2, { ...row, choice: 'drop' });
  });

  it('lets no choice be pressed while the row’s last action is not read back', () => {
    page({
      today: report(CHOSEN),
      settling: new Set([path('Ship the page'), path('Call the bank')]),
    });
    const keep = screen.getByRole('button', { name: 'Keep Ship the page for today' });
    const takeOff = screen.getByRole('button', { name: 'Take Call the bank off today' });
    expect((keep as HTMLButtonElement).disabled).toBe(true);
    expect((takeOff as HTMLButtonElement).disabled).toBe(true);
    const choose = screen.getByRole('button', { name: 'Choose Write the guide for today' });
    expect((choose as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ['choose', 'Chose “Call the bank” for today.'],
    ['unchoose', 'Took “Call the bank” off today.'],
    ['keep', 'Kept “Call the bank” for today.'],
    ['drop', 'Dropped “Call the bank” from today.'],
  ] as const)('says what a %s did, in the words its toast offers to take back', (kind, words) => {
    expect(todayActionWords({ title: 'Call the bank', action: { kind } })).toBe(words);
  });
});
