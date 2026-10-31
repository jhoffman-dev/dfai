// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, readProposal, type InboxItem, type InboxTask } from '@dfai/domain';
import {
  INBOX_OFFERS_AFTER_INDEX_WAIT_MS,
  INBOX_OFFERS_WAIT_MS,
  InboxPage,
  type InboxContents,
  type InboxPageProps,
} from './inbox-page.tsx';
import type { RelationChoice } from './properties-panel.tsx';
import { pickSuggestion, suggestedTitles } from './link-suggest/link-suggest.test-support.ts';

/** A captured task, as the Inbox reads one that says nothing yet but its status. */
const CAPTURED: InboxTask = {
  status: 'inbox',
  project: null,
  waitingOn: null,
  waitingOnNames: '',
  defer: null,
  due: null,
};

const item = (
  path: string,
  title: string,
  type: string | null,
  arrivedIn = '',
  more: Partial<InboxItem> = {},
): InboxItem => ({
  path: createVaultPath(path),
  title,
  type,
  arrivedIn,
  importOutcome: null,
  importError: null,
  task: type === 'task' ? CAPTURED : null,
  ...more,
});

function proposalNamed(title: string) {
  const reading = readProposal({
    path: createVaultPath(`Inbox/Proposals/${title}.md`),
    properties: { type: 'proposal', kind: 'task', payload: { title } },
  });
  if (!reading.ok) throw new Error(reading.problem);
  return reading.proposal;
}

const PROPOSALS: NonNullable<InboxPageProps['proposals']> = {
  contents: { open: [proposalNamed('Send Mara the file')], stranded: [], unreadable: [] },
  error: null,
  notice: null,
  busy: null,
  problems: new Map(),
  onAccept: vi.fn(),
  onReject: vi.fn(),
  onAcceptChoice: vi.fn(),
  selection: { selected: new Set(), onToggle: vi.fn(), onToggleAll: vi.fn() },
  onClearSelection: vi.fn(),
  onAcceptMany: vi.fn(),
  onRejectMany: vi.fn(),
  onDismissNotice: vi.fn(),
  onOpen: vi.fn(),
  onOpenSource: vi.fn(),
};

const CONTENTS: InboxContents = {
  items: [
    item('Inbox/Call the bank.md', 'Call the bank', 'task'),
    item('Inbox/Meetings/Standup.md', 'Standup', 'meeting', 'Meetings'),
    item('Inbox/Idea.md', 'Idea', null),
  ],
  truncated: false,
  total: 3,
};

const FILING: readonly RelationChoice[] = [
  { path: 'Projects/Atlas.md', title: 'Atlas', type: 'project' },
  { path: 'Areas/Garden.md', title: 'Garden', type: 'area' },
];

const PEOPLE: readonly RelationChoice[] = [
  { path: 'People/Mara Quill.md', title: 'Mara Quill', type: 'person' },
  { path: 'People/Tobias Fenn.md', title: 'Tobias Fenn', type: 'person' },
];

function page(overrides: Partial<InboxPageProps> = {}) {
  const props: InboxPageProps = {
    contents: CONTENTS,
    error: null,
    filing: FILING,
    people: PEOPLE,
    onOpen: vi.fn(),
    onShowMore: vi.fn(),
    onClarify: vi.fn(async () => true),
    busy: false,
    problem: null,
    ...overrides,
  };
  const view = render(<InboxPage {...props} />);
  return {
    ...props,
    rerender: (next: Partial<InboxPageProps>) => view.rerender(<InboxPage {...props} {...next} />),
  };
}

const rowOf = (title: string) =>
  screen.getByRole('button', { name: title }).closest('tr') as HTMLElement;

describe('InboxPage', () => {
  it('lists every note waiting, of any type, saying where in the Inbox it arrived', () => {
    page();
    expect(within(rowOf('Call the bank')).getByText('Task')).toBeDefined();
    expect(within(rowOf('Standup')).getByText('Meeting · Meetings')).toBeDefined();
    expect(within(rowOf('Idea')).getByText('Note')).toBeDefined();
    expect(screen.getByText(/3 to process/)).toBeDefined();
  });

  it('opens a note from its name', async () => {
    const props = page();
    await userEvent.click(screen.getByRole('button', { name: 'Standup' }));
    expect(props.onOpen).toHaveBeenCalledWith('Inbox/Meetings/Standup.md');
  });

  it('offers the projects and the areas to file a note under, each named by its type', async () => {
    page();
    const picker = screen.getByRole('combobox', { name: 'File Idea under' });
    expect(picker.getAttribute('placeholder')).toBe('File under…');
    await userEvent.click(picker);
    expect(suggestedTitles()).toEqual(['Atlas', 'Garden']);
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.querySelector('.link-suggest__type')?.textContent),
    ).toEqual(['Projects', 'Areas']);
  });
  it('makes a project of a name no note has, and files the note under it (#465)', async () => {
    const onCreateFiling = vi.fn(async () => createVaultPath('Projects/Kitchen.md'));
    const props = page({ onCreateFiling });
    await userEvent.type(screen.getByRole('combobox', { name: 'File Standup under' }), 'Kitchen');
    await userEvent.click(screen.getByRole('option', { name: 'Create project ‘Kitchen’' }));
    expect(onCreateFiling).toHaveBeenCalledWith({ target: 'project', name: 'Kitchen' });
    expect(props.onClarify).toHaveBeenCalledWith({
      path: 'Inbox/Meetings/Standup.md',
      clarification: { project: 'Projects/Kitchen.md' },
    });
  });

  it('offers no Create where the page cannot make a project', async () => {
    page();
    await userEvent.type(screen.getByRole('combobox', { name: 'File Standup under' }), 'Kitchen');
    expect(screen.queryByRole('option', { name: /^Create/ })).toBeNull();
  });

  it('files a note that is not a task into the project picked, at once', async () => {
    const props = page();
    await pickSuggestion(screen.getByRole('combobox', { name: 'File Standup under' }), 'Garden');
    expect(props.onClarify).toHaveBeenCalledWith({
      path: 'Inbox/Meetings/Standup.md',
      clarification: { project: 'Areas/Garden.md' },
    });
  });

  it('files nothing while a note is being filed, or when there is nothing to file under', () => {
    page({ busy: true });
    expect(
      (screen.getByRole('combobox', { name: 'File Idea under' }) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it('says there is no project or area yet rather than offering an empty list', () => {
    page({ filing: [] });
    const picker = screen.getByRole('combobox', { name: 'File Idea under' }) as HTMLInputElement;
    expect(picker.disabled).toBe(true);
    expect(picker.placeholder).toBe('No project or area yet');
  });

  it('says why the last undo could not be done', () => {
    page({ problem: 'It was changed since, so it was left as it is.' });
    expect(screen.getByRole('alert').textContent).toBe(
      'It was changed since, so it was left as it is.',
    );
  });

  it('says when nothing is waiting', () => {
    page({ contents: { items: [], truncated: false, total: 0 } });
    expect(screen.getByText(/Nothing is waiting/)).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('offers to let the vault’s types link a project or an area, and does it when asked', async () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    page({
      typesOffer: {
        lines: ['Task gains Project, linking project or area notes.'],
        onAccept,
        onDismiss,
      },
    });
    const offer = screen.getByRole('complementary', {
      name: 'Set your types up for the Inbox',
    });
    expect(offer.textContent).toContain('Task gains Project, linking project or area notes.');
    await userEvent.click(within(offer).getByRole('button', { name: 'Add to the types' }));
    expect(onAccept).toHaveBeenCalledOnce();
    await userEvent.click(within(offer).getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('links to the vault’s own Inbox view when it has one', async () => {
    const onOpen = vi.fn();
    page({ view: { title: 'Inbox', onOpen } });
    await userEvent.click(screen.getByRole('button', { name: 'Open the Inbox view' }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('has no offer and no view link when there is neither', () => {
    page();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Open the/ })).toBeNull();
  });

  it('says on a meeting’s row that it waits for the import, or why it was not imported', () => {
    page({
      contents: {
        items: [
          item('Inbox/Meetings/New.md', 'New', 'meeting', 'Meetings', { importOutcome: 'pending' }),
          item('Inbox/Meetings/Broken.md', 'Broken', null, 'Meetings', {
            importOutcome: 'error',
            importError: 'title is required',
          }),
          item('Inbox/Meetings/Done.md', 'Done', 'meeting', 'Meetings', {
            importOutcome: 'imported',
          }),
        ],
        truncated: false,
        total: 3,
      },
    });
    expect(within(rowOf('New')).getByText('Waiting to be imported')).toBeDefined();
    expect(within(rowOf('Broken')).getByText('Not imported: title is required')).toBeDefined();
    expect(within(rowOf('Done')).queryByText(/import/i)).toBeNull();
  });

  it('is headed by the name its bar shows', () => {
    page();
    const named = document.querySelector('.page-bar__name')?.textContent;
    expect(named).toBe('To process');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(named);
  });

  it('shows no count while nothing is to process and nothing to answer', () => {
    page({ contents: { items: [], truncated: false, total: 0 } });
    expect(document.querySelector('.page-bar__count')).toBeNull();
  });

  it('answers proposals in a section of its own, counted beside what is to process', async () => {
    page({ proposals: PROPOSALS });
    const section = screen.getByRole('region', { name: 'Proposals' });
    expect(within(section).getByText(/1 open proposal/)).toBeDefined();
    expect(
      screen.getByText('3 to process · 1 to answer').closest('.page-bar__count'),
    ).not.toBeNull();
    await userEvent.click(within(section).getByRole('button', { name: 'Accept' }));
    expect(PROPOSALS.onAccept).toHaveBeenCalledWith(
      'Inbox/Proposals/Send Mara the file.md',
      undefined,
    );
    expect(screen.queryByRole('combobox', { name: /File Send Mara the file under/ })).toBeNull();
  });

  it('shows no Proposals section while none wait', () => {
    page({ proposals: { ...PROPOSALS, contents: { open: [], stranded: [], unreadable: [] } } });
    expect(screen.getByRole('table')).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Proposals' })).toBeNull();
  });
});

/** #112: a task is clarified where it is, and Done writes the row in one save. */
describe('InboxPage — clarifying a task on its row', () => {
  const TASK = 'Inbox/Call the bank.md';
  const control = (name: string) => screen.getByRole('combobox', { name });
  const done = () => within(rowOf('Call the bank')).getByRole('button', { name: 'Save' });

  it('offers the eight statuses, with the task’s own picked', () => {
    page();
    const status = control('Status of Call the bank') as HTMLSelectElement;
    expect([...status.options].map((option) => option.textContent)).toEqual([
      'Inbox',
      'Backlog',
      'Next Action',
      'In Progress',
      'Waiting',
      'Someday',
      'Longterm',
      'Archive',
    ]);
    expect(status.value).toBe('inbox');
  });

  it('offers only the statuses the vault’s Task type declares, and the one the task holds', () => {
    page({ statuses: ['backlog', 'someday'] });
    const status = control('Status of Call the bank') as HTMLSelectElement;
    expect([...status.options].map((option) => option.textContent)).toEqual([
      'Inbox',
      'Backlog',
      'Someday',
    ]);
  });

  it('does not write a person picked while the row said Waiting once the status was changed again', async () => {
    const props = page();
    await userEvent.selectOptions(control('Status of Call the bank'), 'Waiting');
    await pickSuggestion(control('Who Call the bank waits on'), 'Mara Quill');
    await userEvent.selectOptions(control('Status of Call the bank'), 'Next Action');
    expect(screen.queryByRole('combobox', { name: 'Who Call the bank waits on' })).toBeNull();
    await userEvent.click(done());
    expect(props.onClarify).toHaveBeenCalledWith({
      path: TASK,
      clarification: { status: 'next-action' },
    });
  });

  it('offers no status, wait or date on a note that is not a task', () => {
    page();
    expect(screen.queryByRole('combobox', { name: 'Status of Standup' })).toBeNull();
    expect(screen.queryByLabelText('Standup is due')).toBeNull();
  });

  it('writes nothing until Done, which has nothing to write until something is picked', async () => {
    const props = page();
    expect((done() as HTMLButtonElement).disabled).toBe(true);

    await userEvent.selectOptions(control('Status of Call the bank'), 'Next Action');
    await pickSuggestion(control('File Call the bank under'), 'Atlas');

    expect(props.onClarify).not.toHaveBeenCalled();
    expect((done() as HTMLButtonElement).disabled).toBe(false);
  });

  it('writes the status and the project together on Done', async () => {
    const props = page();
    await userEvent.selectOptions(control('Status of Call the bank'), 'Next Action');
    await pickSuggestion(control('File Call the bank under'), 'Atlas');
    await userEvent.click(done());

    expect(props.onClarify).toHaveBeenCalledTimes(1);
    expect(props.onClarify).toHaveBeenCalledWith({
      path: TASK,
      clarification: { status: 'next-action', project: 'Projects/Atlas.md' },
    });
  });

  it('asks who it waits on once Waiting is picked, and writes both in one clarification', async () => {
    const props = page();
    expect(screen.queryByRole('combobox', { name: 'Who Call the bank waits on' })).toBeNull();

    await userEvent.selectOptions(control('Status of Call the bank'), 'Waiting');
    const who = control('Who Call the bank waits on');
    expect(who.getAttribute('placeholder')).toBe('Waiting on…');
    await userEvent.click(who);
    expect(suggestedTitles()).toEqual(['Mara Quill', 'Tobias Fenn']);
    await pickSuggestion(who, 'Mara Quill');
    await userEvent.click(done());

    expect(props.onClarify).toHaveBeenCalledTimes(1);
    expect(props.onClarify).toHaveBeenCalledWith({
      path: TASK,
      clarification: { status: 'waiting', waitingOn: 'People/Mara Quill.md' },
    });
  });

  it('writes a status alone: a single action needs no project', async () => {
    const props = page();
    await userEvent.selectOptions(control('Status of Call the bank'), 'Someday');
    await userEvent.click(done());
    expect(props.onClarify).toHaveBeenCalledWith({
      path: TASK,
      clarification: { status: 'someday' },
    });
  });

  it('writes defer and due as days, and Return in a date is Done', async () => {
    const props = page();
    await userEvent.type(screen.getByLabelText('Defer Call the bank until'), '2026-10-20');
    await userEvent.type(screen.getByLabelText('Call the bank is due'), '2026-11-02{Enter}');
    expect(props.onClarify).toHaveBeenCalledWith({
      path: TASK,
      clarification: { defer: '2026-10-20', due: '2026-11-02' },
    });
  });

  it('shows what the task already says, and clears a date that is emptied', async () => {
    const held: InboxTask = {
      status: 'waiting',
      project: createVaultPath('Areas/Garden.md'),
      waitingOn: createVaultPath('People/Tobias Fenn.md'),
      waitingOnNames: 'Tobias Fenn',
      defer: null,
      due: '2026-11-02',
    };
    const props = page({
      contents: {
        items: [item('Tasks/Chase.md', 'Chase', 'task', '', { task: held })],
        truncated: false,
        total: 1,
      },
    });
    expect((control('Status of Chase') as HTMLSelectElement).value).toBe('waiting');
    expect((control('File Chase under') as HTMLInputElement).value).toBe('Garden');
    expect((control('Who Chase waits on') as HTMLInputElement).value).toBe('Tobias Fenn');

    await userEvent.clear(screen.getByLabelText('Chase is due'));
    await userEvent.click(within(rowOf('Chase')).getByRole('button', { name: 'Save' }));
    expect(props.onClarify).toHaveBeenCalledWith({
      path: 'Tasks/Chase.md',
      clarification: { due: null },
    });
  });

  it('shows a refusal on the row it was for, and keeps what was picked', async () => {
    const refusal = {
      path: createVaultPath(TASK),
      reason: 'That task has changed since: read it again.',
    };
    page({ onClarify: vi.fn(async () => false), refusals: [refusal] });
    const alert = within(rowOf('Call the bank')).getByRole('alert');
    expect(alert.textContent).toBe('That task has changed since: read it again.');
    expect(within(rowOf('Standup')).queryByRole('alert')).toBeNull();

    await userEvent.selectOptions(control('Status of Call the bank'), 'Waiting');
    await userEvent.click(done());
    expect((control('Status of Call the bank') as HTMLSelectElement).value).toBe('waiting');
  });

  it('says a refusal above the list once its row has left it', () => {
    page({
      refusals: [{ path: createVaultPath('Inbox/Gone.md'), reason: 'Gone: the disk is full' }],
    });
    expect(screen.getByRole('alert').textContent).toBe('Gone: the disk is full');
  });

  it('puts the focus on the next row once a row is done, and leaves it when refused', async () => {
    page();
    await userEvent.selectOptions(control('Status of Call the bank'), 'Backlog');
    await userEvent.click(done());
    expect(document.activeElement).toBe(rowOf('Standup'));
    expect(rowOf('Standup').className).toContain('inbox__row--focused');
  });

  it('leaves the focus where it is when the row was refused', async () => {
    page({ onClarify: vi.fn(async () => false) });
    await userEvent.selectOptions(control('Status of Call the bank'), 'Backlog');
    await userEvent.click(done());
    expect(document.activeElement).toBe(done());
  });

  it('reaches every control of a row with Tab, in the order it is read', async () => {
    page();
    screen.getByRole('button', { name: 'Call the bank' }).focus();
    const reached: (string | null)[] = [];
    for (let stop = 0; stop < 4; stop += 1) {
      await userEvent.tab();
      reached.push(document.activeElement?.getAttribute('aria-label') ?? null);
    }
    expect(reached).toEqual([
      'Status of Call the bank',
      'File Call the bank under',
      'Defer Call the bank until',
      'Call the bank is due',
    ]);
  });

  it('makes a plain note a task from its row, and offers that on no other', async () => {
    const props = page();
    expect(within(rowOf('Standup')).queryByRole('button', { name: 'Make task' })).toBeNull();
    await userEvent.click(within(rowOf('Idea')).getByRole('button', { name: 'Make task' }));
    expect(props.onClarify).toHaveBeenCalledWith({
      path: 'Inbox/Idea.md',
      clarification: { asTask: true },
    });
  });

  it('draws no undo bar of its own: a clarification is said in the window’s toasts (#320)', () => {
    page();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(document.querySelector('.inbox__done')).toBeNull();
  });
});

describe('InboxPage — more waiting than one page (#167)', () => {
  const FULL: InboxContents = { ...CONTENTS, truncated: true, total: 734 };

  it('says how many wait in all, and how many are shown', () => {
    page({ contents: FULL, onShowMore: vi.fn() });
    expect(screen.getByText(/^734 to process/)).toBeTruthy();
    expect(screen.getByText('Showing the newest 3 of 734.')).toBeTruthy();
  });

  it('shows more when asked, so every note can be reached', async () => {
    const onShowMore = vi.fn();
    page({ contents: FULL, onShowMore });
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(onShowMore).toHaveBeenCalledOnce();
  });

  it('offers no more once everything is shown', () => {
    page({ contents: { ...CONTENTS, total: 3 }, onShowMore: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(screen.getByText(/^3 to process/)).toBeTruthy();
  });
});

describe('InboxPage: when DFAI can’t tell which action items are yours (#181)', () => {
  const notice = () =>
    screen.queryByRole('alert', { name: 'DFAI can’t tell which action items are yours' });

  it('says so, and opens Settings', async () => {
    const onOpenSettings = vi.fn();
    page({ ownerUnknown: { onOpenSettings } });

    expect(notice()?.textContent).toContain('meetings make no tasks for you');
    expect(notice()?.textContent).toContain('Settings → Profile');
    await userEvent.click(within(notice()!).getByRole('button', { name: 'Open Settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('says nothing once the owner can be told apart', () => {
    const { rerender } = page({ ownerUnknown: { onOpenSettings: vi.fn() } });
    expect(notice()).not.toBeNull();

    rerender({ ownerUnknown: null });
    expect(notice()).toBeNull();
  });
});

describe('InboxPage: while the vault’s settings note cannot be read (#226)', () => {
  const notice = () => screen.queryByRole('alert', { name: 'Meetings and automations are paused' });

  it('says meetings and automations are paused, why, that nothing is lost, and opens Settings', async () => {
    const onOpenSettings = vi.fn();
    page({ settingsUnreadable: { problem: 'line 3: a list is not closed', onOpenSettings } });

    expect(notice()?.textContent).toContain('.atlas/settings.md can’t be read');
    expect(notice()?.textContent).toContain('line 3: a list is not closed');
    expect(notice()?.textContent).toContain('meetings wait in their folder');
    expect(notice()?.textContent).toContain('resume once it reads');
    await userEvent.click(within(notice()!).getByRole('button', { name: 'Open Settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('says nothing once it reads', () => {
    const { rerender } = page({
      settingsUnreadable: { problem: 'line 3: a list is not closed', onOpenSettings: vi.fn() },
    });
    expect(notice()).not.toBeNull();

    rerender({ settingsUnreadable: null });
    expect(notice()).toBeNull();
  });
});

describe('InboxPage: meetings waiting for the named Mac (ADR-0035 part 1, #175)', () => {
  const banner = () => screen.queryByRole('status', { name: 'Meetings waiting' });

  const line = (text: string) => ({ line: text, processHere: null });

  it('shows the line it is given, above the rows', () => {
    page({ meetingsWaiting: line('3 meetings waiting for Studio') });

    expect(banner()?.textContent).toBe('3 meetings waiting for Studio');
    const list = screen.getByRole('article', { name: 'Inbox' });
    const firstRow = rowOf('Idea');
    expect(list.contains(banner())).toBe(true);
    // Drawn before the rows, so it is read first.
    expect(
      banner()!.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('draws nothing on the named Mac, which is given no line', () => {
    const { rerender } = page({ meetingsWaiting: line('1 meeting waiting for Studio') });
    expect(banner()).not.toBeNull();

    rerender({ meetingsWaiting: null });
    expect(banner()).toBeNull();
    expect(screen.queryByText(/waiting for Studio/)).toBeNull();
  });
});

describe('InboxPage: "Process here" on the banner (ADR-0035 part 2, #176)', () => {
  const banner = () => screen.getByRole('status', { name: 'Meetings waiting' });
  const button = () => within(banner()).getByRole('button', { name: /Process here|Processing/ });
  const offer = (over: Partial<NonNullable<InboxPageProps['meetingsWaiting']>['processHere']>) => ({
    line: '2 meetings waiting for Studio',
    processHere: { refused: null, busy: false, problem: null, onPress: vi.fn(), ...over },
  });

  it('claims when pressed', async () => {
    const onPress = vi.fn();
    page({ meetingsWaiting: offer({ onPress }) });

    await userEvent.click(button());

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is refused, and says which, while sync could not share the claim', async () => {
    const onPress = vi.fn();
    page({
      meetingsWaiting: offer({ onPress, refused: 'Sync is paused on this Mac: resume it.' }),
    });

    expect((button() as HTMLButtonElement).disabled).toBe(true);
    expect(within(banner()).getByText('Sync is paused on this Mac: resume it.')).toBeTruthy();
    await userEvent.click(button());
    expect(onPress).not.toHaveBeenCalled();
  });

  it('cannot be pressed twice while one press is written', () => {
    page({ meetingsWaiting: offer({ busy: true }) });

    expect((button() as HTMLButtonElement).disabled).toBe(true);
    expect(button().textContent).toBe('Processing…');
  });

  it('says why the last press named no Mac', () => {
    page({ meetingsWaiting: offer({ problem: 'The vault’s settings cannot be read.' }) });

    expect(within(banner()).getByText('The vault’s settings cannot be read.')).toBeTruthy();
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the live refusal before an older press’s problem (#630 review)', () => {
    page({
      meetingsWaiting: offer({ refused: 'Sync is paused on this Mac.', problem: 'Older problem.' }),
    });

    expect(within(banner()).getByText('Sync is paused on this Mac.')).toBeTruthy();
    expect(within(banner()).queryByText('Older problem.')).toBeNull();
  });

  it('shows no button until sync says where the vault stands', () => {
    page({ meetingsWaiting: { line: '2 meetings waiting for Studio', processHere: null } });

    expect(banner().textContent).toBe('2 meetings waiting for Studio');
    expect(within(banner()).queryByRole('button')).toBeNull();
  });
});

describe('InboxPage: the named Mac’s step cannot reach Claude (#182)', () => {
  it('shows the line and the fix-it words under it, with nothing to press', () => {
    page({
      meetingsWaiting: {
        line: 'Claude is unavailable on Studio: summaries and tasks are pending for 2 meetings.',
        detail: 'Claude Code is installed but not logged in. Fix: claude auth login',
        processHere: null,
      },
    });

    const banner = screen.getByRole('status', { name: 'Meetings waiting' });
    expect(within(banner).getByText(/pending for 2 meetings/)).toBeTruthy();
    expect(within(banner).getByText(/Fix: claude auth login/)).toBeTruthy();
    expect(within(banner).queryByRole('button')).toBeNull();
  });
});

const VAULT_TIDY: NonNullable<InboxPageProps['vaultTidy']> = {
  preview: {
    moves: [{ from: 'Loose idea.md', to: 'Notes/2026/Loose idea.md' }],
    refused: [],
  },
  open: false,
  busy: false,
  result: null,
  problem: null,
  onOpen: vi.fn(),
  onApply: vi.fn(),
  onClose: vi.fn(),
  onDismiss: vi.fn(),
};
/** The tidy while the vault is still read for it: nothing known to offer yet. */
const READING = { ...VAULT_TIDY, preview: null, reading: true };

describe('InboxPage — an offer read late does not move the ones already shown (#227)', () => {
  const TYPES_OFFER: NonNullable<InboxPageProps['typesOffer']> = {
    lines: ['Task gains Project, linking project or area notes.'],
    onAccept: vi.fn(),
    onDismiss: vi.fn(),
  };
  const MEETING_PROJECTS: NonNullable<InboxPageProps['meetingProjects']> = {
    rows: [
      {
        path: 'Meetings/2026-10-06 Larkspur standup.md',
        meeting: '2026-10-06 Larkspur standup',
        project: 'Ledger',
        confidence: 'high',
        reason:
          'Same series as 2026-10-05 Larkspur standup: 3 of its last 3 were filed under Ledger.',
        chosen: true,
      },
    ],
    open: false,
    busy: false,
    result: null,
    problem: null,
    canUndo: false,
    onOpen: vi.fn(),
    onToggle: vi.fn(),
    onRun: vi.fn(),
    onClose: vi.fn(),
    onUndo: vi.fn(),
    onDismiss: vi.fn(),
  };
  const typesOffer = () => screen.getByRole('complementary', { name: /Set your types up/ });
  const meetingOffer = () => screen.getByRole('region', { name: 'File meetings under projects' });
  const precedes = (first: HTMLElement, second: HTMLElement) =>
    (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it('puts an offer read after another below it, so what is under the pointer stays put', () => {
    // While another is still read, so the rows are not drawn yet (#130).
    const view = page({ meetingProjects: MEETING_PROJECTS, vaultTidy: READING });
    view.rerender({
      meetingProjects: MEETING_PROJECTS,
      vaultTidy: READING,
      typesOffer: TYPES_OFFER,
    });
    expect(precedes(meetingOffer(), typesOffer())).toBe(true);
  });

  it('keeps the usual order for the offers read together', () => {
    page({ meetingProjects: MEETING_PROJECTS, typesOffer: TYPES_OFFER });
    expect(precedes(typesOffer(), meetingOffer())).toBe(true);
  });
});

describe('InboxPage — nothing moves under the pointer once the rows are drawn (#130)', () => {
  const TYPES_OFFER: NonNullable<InboxPageProps['typesOffer']> = {
    lines: ['Task gains Project, linking project or area notes.'],
    onAccept: vi.fn(),
    onDismiss: vi.fn(),
  };
  const tidyOffer = () => screen.queryByRole('region', { name: 'Tidy the vault' });
  const firstRow = () => screen.queryByRole('button', { name: 'Call the bank' });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the rows back while an offer is still being read, then draws them below it', () => {
    const view = page({ vaultTidy: READING, proposals: PROPOSALS });
    expect(firstRow()).toBeNull();
    expect(screen.queryByRole('region', { name: 'Proposals' })).toBeNull();
    // Drawn in place, so showing them costs nothing, but out of reach until then.
    const held = screen.getByText('Call the bank');
    expect(held.closest('[inert]')).not.toBeNull();

    view.rerender({ vaultTidy: VAULT_TIDY, proposals: PROPOSALS });
    const offer = tidyOffer();
    const row = firstRow();
    expect(offer).not.toBeNull();
    expect(row).not.toBeNull();
    expect((offer!.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(
      true,
    );
  });

  // Late now means shown at once: the rows are held still on screen as it lands (list-anchor.test.tsx).
  it('draws the rows anyway once a slow read has had its time, and shows that offer when it comes', () => {
    vi.useFakeTimers();
    const view = page({ vaultTidy: READING });
    expect(firstRow()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(INBOX_OFFERS_WAIT_MS);
    });
    expect(firstRow()).not.toBeNull();

    view.rerender({ vaultTidy: VAULT_TIDY });
    expect(tidyOffer()).not.toBeNull();
    expect(firstRow()).not.toBeNull();
  });

  it('holds the rows with no time limit while an offer waits for the index, then a longer limit once it is ready', () => {
    vi.useFakeTimers();
    const waiting = { ...READING, waitingForIndex: true };
    const view = page({ vaultTidy: waiting });
    act(() => {
      vi.advanceTimersByTime(INBOX_OFFERS_WAIT_MS * 20);
    });
    // Still drawn in place, unseen and out of reach: a vault just opened has no index yet.
    expect(firstRow()).toBeNull();
    expect(screen.getByText('Call the bank').closest('[inert]')).not.toBeNull();

    // Index ready: the offers are read all at once, so the page waits its longer limit.
    view.rerender({ vaultTidy: READING });
    act(() => {
      vi.advanceTimersByTime(INBOX_OFFERS_WAIT_MS);
    });
    expect(firstRow()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(INBOX_OFFERS_AFTER_INDEX_WAIT_MS);
    });
    expect(firstRow()).not.toBeNull();
  });

  it('holds the rows back while the types offer is still being read, as it does for the others (#381)', () => {
    const view = page({ typesOffer: { ...TYPES_OFFER, lines: [], reading: true } });
    expect(firstRow()).toBeNull();
    expect(screen.queryByRole('complementary', { name: /Set your types up/ })).toBeNull();

    view.rerender({ typesOffer: TYPES_OFFER });
    const offer = screen.getByRole('complementary', { name: /Set your types up/ });
    const row = firstRow();
    expect(row).not.toBeNull();
    expect((offer.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(
      true,
    );
  });

  it('shows an offer that arrives after the rows are drawn, without waiting for the next open', () => {
    const view = page();
    expect(firstRow()).not.toBeNull();
    view.rerender({ typesOffer: TYPES_OFFER });
    expect(screen.queryByRole('complementary', { name: /Set your types up/ })).not.toBeNull();
    expect(firstRow()).not.toBeNull();
  });

  it('still changes an offer already shown, as the person answers it', () => {
    const view = page({ vaultTidy: VAULT_TIDY });
    expect(tidyOffer()).not.toBeNull();
    view.rerender({ vaultTidy: { ...VAULT_TIDY, preview: null, result: 'Tidied the vault.' } });
    expect(within(tidyOffer()!).getByRole('status').textContent).toBe('Tidied the vault.');
  });

  it('keeps showing an offer already shown that is briefly read as nothing, as a run settles', () => {
    const view = page({ vaultTidy: VAULT_TIDY });
    expect(tidyOffer()).not.toBeNull();
    // Read again mid-run: the moves are made, and the run has not said so yet.
    view.rerender({ vaultTidy: null });
    view.rerender({ vaultTidy: { ...VAULT_TIDY, preview: null, result: 'Tidied the vault.' } });
    expect(within(tidyOffer()!).getByRole('status').textContent).toBe('Tidied the vault.');
  });
});

describe('InboxPage — one-key triage on the focused row (#109, #307)', () => {
  const TITLES = [
    'Call the bank',
    'Chase the quote',
    'Learn the cello',
    'Renew the passport',
    'Fix the gate',
  ];
  const tasks = (): InboxContents => ({
    items: TITLES.map((title) => item(`Inbox/${title}.md`, title, 'task')),
    truncated: false,
    total: TITLES.length,
  });
  const clarified = (onClarify: InboxPageProps['onClarify']) =>
    (onClarify as ReturnType<typeof vi.fn>).mock.calls.map(([args]) => args);
  const keyButton = (title: string, name: string) =>
    within(rowOf(title)).getByRole('button', { name });
  const focusRow = (title: string) => act(() => rowOf(title).focus());

  it('works five rows top to bottom by key alone: each status is written at once, and the focus moves on', async () => {
    const { onClarify } = page({ contents: tasks() });
    focusRow('Call the bank');
    await userEvent.keyboard('n');
    expect(clarified(onClarify)).toEqual([
      { path: 'Inbox/Call the bank.md', clarification: { status: 'next-action' } },
    ]);
    expect(document.activeElement).toBe(rowOf('Chase the quote'));

    await userEvent.keyboard('w');
    await userEvent.keyboard('s');
    await userEvent.keyboard('d');
    await userEvent.keyboard('n');
    expect(clarified(onClarify).slice(1)).toEqual([
      { path: 'Inbox/Chase the quote.md', clarification: { status: 'waiting' } },
      { path: 'Inbox/Learn the cello.md', clarification: { status: 'someday' } },
      { path: 'Inbox/Renew the passport.md', clarification: { status: 'archive' } },
      { path: 'Inbox/Fix the gate.md', clarification: { status: 'next-action' } },
    ]);
    // The last row was the only one left to go to: the focus stays on it.
    expect(document.activeElement).toBe(rowOf('Renew the passport'));
  });

  // The app takes a row off the list as soon as it is asked, and writes it after (#260): the keys must keep up.
  it('moves the focus on as soon as the row leaves the list, before its write is done, so the next key lands on the next row (#308)', async () => {
    const writes: Array<(done: boolean) => void> = [];
    const onClarify = vi.fn(() => new Promise<boolean>((settle) => writes.push(settle)));
    const all = tasks();
    const view = page({ contents: all, onClarify });
    const leaving = (...gone: string[]) =>
      view.rerender({
        contents: { ...all, items: all.items.filter((each) => !gone.includes(each.title)) },
      });
    focusRow('Call the bank');
    await userEvent.keyboard('n');
    leaving('Call the bank');
    expect(document.activeElement).toBe(rowOf('Chase the quote'));

    await userEvent.keyboard('w');
    leaving('Call the bank', 'Chase the quote');
    expect(document.activeElement).toBe(rowOf('Learn the cello'));
    expect(clarified(onClarify)).toEqual([
      { path: 'Inbox/Call the bank.md', clarification: { status: 'next-action' } },
      { path: 'Inbox/Chase the quote.md', clarification: { status: 'waiting' } },
    ]);

    // Written at last, each says done: the focus has moved on since, and stays where it is.
    await act(async () => {
      for (const settle of writes) settle(true);
    });
    expect(document.activeElement).toBe(rowOf('Learn the cello'));
  });

  it('skips a row that left at the same moment, and leaves the focus alone when it was elsewhere (#308)', async () => {
    const all = tasks();
    const view = page({ contents: all, onClarify: vi.fn(() => new Promise<boolean>(() => {})) });
    const without = (...gone: string[]) => ({
      ...all,
      items: all.items.filter((each) => !gone.includes(each.title)),
    });
    focusRow('Call the bank');
    await userEvent.keyboard('n');
    // Synced away with it: the focus goes to the first row still listed after it.
    view.rerender({ contents: without('Call the bank', 'Chase the quote') });
    expect(document.activeElement).toBe(rowOf('Learn the cello'));

    // The focus in the page bar, not the row: a row leaving does not take it.
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    act(() => elsewhere.focus());
    view.rerender({ contents: without('Call the bank', 'Chase the quote', 'Learn the cello') });
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('leaves the focus on the page when the person put it there before the row left (#423 review)', async () => {
    const all = tasks();
    const view = page({ contents: all });
    focusRow('Call the bank');
    // The blur is the person's: the hook reads it once the focus has settled.
    await act(async () => rowOf('Call the bank').blur());
    expect(document.activeElement).toBe(document.body);

    view.rerender({
      contents: { ...all, items: all.items.filter((each) => each.title !== 'Call the bank') },
    });
    expect(document.activeElement).toBe(document.body);
  });

  it('gives the focus back to the last row when its key emptied the list and the write was refused (#423)', async () => {
    let refuse: (done: boolean) => void = () => {};
    const onClarify = vi.fn(() => new Promise<boolean>((settle) => (refuse = settle)));
    const only = {
      items: tasks().items.filter((each) => each.title === 'Fix the gate'),
      truncated: false,
      total: 1,
    };
    const view = page({ contents: only, onClarify });
    focusRow('Fix the gate');
    await userEvent.keyboard('n');
    view.rerender({ contents: { ...only, items: [], total: 0 } });
    // The page holds the focus the last row had, so U still reaches it (#109).
    expect(document.activeElement).toBe(screen.getByRole('article', { name: 'Inbox' }));

    // Refused: the row comes back, and the next key must land on it, not on the page.
    await act(async () => refuse(false));
    view.rerender({ contents: only });
    expect(document.activeElement).toBe(rowOf('Fix the gate'));
    await userEvent.keyboard('s');
    expect(clarified(onClarify).at(-1)).toEqual({
      path: 'Inbox/Fix the gate.md',
      clarification: { status: 'someday' },
    });
  });

  it('shows the six keys on the focused row only, in the order Next, Waiting, Someday, Schedule, Project, Done', () => {
    page({ contents: tasks() });
    expect(screen.queryAllByRole('button', { name: /, key [A-Z]$/ })).toHaveLength(0);
    focusRow('Chase the quote');
    const shown = within(rowOf('Chase the quote')).getAllByRole('button', { name: /, key [A-Z]$/ });
    expect(shown.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Next, key N',
      'Waiting, key W',
      'Someday, key S',
      'Schedule, key T',
      'Project, key P',
      'Done, key D',
    ]);
    expect(within(rowOf('Call the bank')).queryAllByRole('button', { name: /, key/ })).toHaveLength(
      0,
    );
  });

  it('acts on a click of the key as on the key itself', async () => {
    const { onClarify } = page({ contents: tasks() });
    focusRow('Learn the cello');
    await userEvent.click(keyButton('Learn the cello', 'Done, key D'));
    expect(clarified(onClarify)).toEqual([
      { path: 'Inbox/Learn the cello.md', clarification: { status: 'archive' } },
    ]);
  });

  it('does nothing while a field has the focus: the letter is typed, not acted on', async () => {
    const { onClarify } = page({ contents: tasks() });
    const status = screen.getByRole('combobox', { name: 'Status of Call the bank' });
    act(() => status.focus());
    await userEvent.keyboard('n');
    act(() => screen.getByLabelText('Defer Call the bank until').focus());
    await userEvent.keyboard('n');
    expect(onClarify).not.toHaveBeenCalled();
    // The row itself, though, is live.
    focusRow('Call the bank');
    await userEvent.keyboard('n');
    expect(onClarify).toHaveBeenCalledOnce();
  });

  it('does nothing for a chord: ⌘N, ⌃N and ⌥N are the app’s or the system’s', async () => {
    const { onClarify } = page({ contents: tasks() });
    focusRow('Call the bank');
    await userEvent.keyboard('{Meta>}n{/Meta}');
    await userEvent.keyboard('{Control>}n{/Control}');
    await userEvent.keyboard('{Alt>}n{/Alt}');
    expect(onClarify).not.toHaveBeenCalled();
    await userEvent.keyboard('{Shift>}n{/Shift}');
    expect(onClarify).toHaveBeenCalledOnce();
  });

  it('P opens the project picker; typing narrows it, and Enter writes the project, the status unchanged', async () => {
    const { onClarify } = page({ contents: tasks() });
    focusRow('Call the bank');
    await userEvent.keyboard('p');
    const picker = screen.getByRole('combobox', { name: 'File Call the bank under' });
    expect(document.activeElement).toBe(picker);
    // Typing only narrows the suggestions: that alone writes nothing.
    await userEvent.keyboard('atl');
    expect(suggestedTitles()).toEqual(['Atlas']);
    expect(onClarify).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    expect(clarified(onClarify)).toEqual([
      { path: 'Inbox/Call the bank.md', clarification: { project: 'Projects/Atlas.md' } },
    ]);
  });
  it('T opens the defer date; the day picked is held, and Enter writes it', async () => {
    const { onClarify } = page({ contents: tasks() });
    focusRow('Call the bank');
    await userEvent.keyboard('t');
    const defer = screen.getByLabelText('Defer Call the bank until');
    expect(document.activeElement).toBe(defer);
    fireEvent.change(defer, { target: { value: '2026-11-02' } });
    expect(onClarify).not.toHaveBeenCalled();
    fireEvent.keyDown(defer, { key: 'Enter' });
    expect(clarified(onClarify)).toEqual([
      { path: 'Inbox/Call the bank.md', clarification: { defer: '2026-11-02' } },
    ]);
  });

  it('holds a pick for Done again once the picker a key opened is left without one', async () => {
    const { onClarify } = page({ contents: tasks() });
    focusRow('Call the bank');
    await userEvent.keyboard('p');
    const picker = screen.getByRole('combobox', { name: 'File Call the bank under' });
    act(() => picker.blur());
    await pickSuggestion(picker, 'Atlas');
    expect(onClarify).not.toHaveBeenCalled();
    const done = within(rowOf('Call the bank')).getByRole('button', { name: 'Save' });
    expect((done as HTMLButtonElement).disabled).toBe(false);
  });
  it('offers no key for a status the vault’s Task type lacks, and the key does nothing', async () => {
    const { onClarify } = page({
      contents: tasks(),
      statuses: ['inbox', 'next-action', 'waiting', 'archive'],
    });
    focusRow('Call the bank');
    expect(
      within(rowOf('Call the bank')).queryByRole('button', { name: 'Someday, key S' }),
    ).toBeNull();
    expect(keyButton('Call the bank', 'Next, key N')).toBeTruthy();
    await userEvent.keyboard('s');
    expect(onClarify).not.toHaveBeenCalled();
  });

  it('offers a note that is not a task only P, which files it; a status key does nothing to it', async () => {
    const { onClarify } = page();
    focusRow('Standup');
    const shown = within(rowOf('Standup')).getAllByRole('button', { name: /, key [A-Z]$/ });
    expect(shown.map((button) => button.getAttribute('aria-label'))).toEqual(['Project, key P']);
    await userEvent.keyboard('n');
    expect(onClarify).not.toHaveBeenCalled();
    await userEvent.keyboard('p');
    const picker = screen.getByRole('combobox', { name: 'File Standup under' });
    expect(document.activeElement).toBe(picker);
    await userEvent.keyboard('gar');
    expect(onClarify).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    expect(clarified(onClarify)).toEqual([
      { path: 'Inbox/Meetings/Standup.md', clarification: { project: 'Areas/Garden.md' } },
    ]);
  });

  it('writes a pick the pointer made from the opened list at once', async () => {
    const { onClarify } = page({ contents: tasks() });
    focusRow('Call the bank');
    await userEvent.keyboard('p');
    await userEvent.keyboard('atl');
    await userEvent.click(screen.getByRole('option', { name: /^Atlas,/ }));
    expect(clarified(onClarify)).toEqual([
      { path: 'Inbox/Call the bank.md', clarification: { project: 'Projects/Atlas.md' } },
    ]);
  });
  it('writes the project on Tab from the armed picker, as on Enter: Tab takes the match', async () => {
    const { onClarify } = page({ contents: tasks() });
    focusRow('Call the bank');
    await userEvent.keyboard('p');
    await userEvent.keyboard('atl');
    await userEvent.tab();
    expect(clarified(onClarify)).toEqual([
      { path: 'Inbox/Call the bank.md', clarification: { project: 'Projects/Atlas.md' } },
    ]);
  });

  it('writes nothing for the letters typed into the armed picker until a note is picked', async () => {
    const { onClarify } = page({ contents: tasks() });
    focusRow('Call the bank');
    await userEvent.keyboard('p');
    fireEvent.pointerDown(screen.getByRole('combobox', { name: 'File Call the bank under' }));
    await userEvent.keyboard('atlas');
    expect(onClarify).not.toHaveBeenCalled();
  });
  it('Escape closes the suggestions, then leaves the armed picker and gives the row the focus back', async () => {
    const { onClarify } = page({ contents: tasks() });
    focusRow('Call the bank');
    await userEvent.keyboard('p');
    const picker = screen.getByRole('combobox', { name: 'File Call the bank under' });
    await userEvent.keyboard('atl');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(picker);
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).toBe(rowOf('Call the bank'));
    expect((picker as HTMLInputElement).value).toBe('');
    expect(onClarify).not.toHaveBeenCalled();
  });
  it('Escape gives back the pick the row held before the key armed the picker', async () => {
    const { onClarify } = page({ contents: tasks() });
    focusRow('Call the bank');
    const picker = screen.getByRole('combobox', { name: 'File Call the bank under' });
    // Held with the mouse, before any key.
    await pickSuggestion(picker, 'Atlas');
    focusRow('Call the bank');
    fireEvent.keyDown(rowOf('Call the bank'), { key: 'p' });
    await userEvent.keyboard('gar');
    await userEvent.keyboard('{Escape}{Escape}');
    expect((picker as HTMLInputElement).value).toBe('Atlas');
    expect(onClarify).not.toHaveBeenCalled();
  });
  it('writes the picks a row holds together with a status key', async () => {
    const { onClarify } = page({ contents: tasks() });
    focusRow('Call the bank');
    await pickSuggestion(
      screen.getByRole('combobox', { name: 'File Call the bank under' }),
      'Atlas',
    );
    fireEvent.keyDown(rowOf('Call the bank'), { key: 'w' });
    await act(async () => {});
    expect(clarified(onClarify)).toEqual([
      {
        path: 'Inbox/Call the bank.md',
        clarification: { status: 'waiting', project: 'Projects/Atlas.md' },
      },
    ]);
  });

  it('leaves a letter typed into anything editable inside the row alone', async () => {
    const { onClarify } = page({ contents: tasks() });
    focusRow('Call the bank');
    const editable = document.createElement('div');
    // jsdom does not compute isContentEditable; a browser does, also for the editing host's children.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    rowOf('Call the bank').appendChild(editable);
    fireEvent.keyDown(editable, { key: 'n' });
    await act(async () => {});
    expect(onClarify).not.toHaveBeenCalled();
  });

  it('offers no P when there is nothing to file under', () => {
    page({ contents: tasks(), filing: [] });
    focusRow('Call the bank');
    expect(
      within(rowOf('Call the bank')).queryByRole('button', { name: 'Project, key P' }),
    ).toBeNull();
  });

  it('holds its keys while a write is on its way, as every control does', () => {
    page({ contents: tasks(), busy: true });
    focusRow('Call the bank');
    expect((keyButton('Call the bank', 'Next, key N') as HTMLButtonElement).disabled).toBe(true);
  });
});
