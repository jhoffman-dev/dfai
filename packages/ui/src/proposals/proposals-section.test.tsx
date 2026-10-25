// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, readProposal, type ProposalNote, type VaultPath } from '@dfai/domain';
import type { RowSelection } from '../row-selection.tsx';
import {
  ProposalsSection,
  proposalsToShow,
  type ProposalsSectionProps,
} from './proposals-section.tsx';

function proposal(name: string, properties: Record<string, unknown>): ProposalNote {
  const reading = readProposal({
    path: createVaultPath(`Inbox/Proposals/${name}.md`),
    properties: { type: 'proposal', ...properties },
  });
  if (!reading.ok) throw new Error(reading.problem);
  return reading.proposal;
}

const TASK = proposal('Send the file', {
  kind: 'task',
  confidence: 'high',
  source: '[[2026-10-01 Standup#^t0003]]',
  made_by: 'after-meeting · run 1',
  payload: {
    title: 'Send Mara the payroll file',
    properties: { status: 'next', people: ['[[Mara Quill]]', '[[Tobias Fenn]]'] },
    body: 'By Friday.',
  },
});

const LINK = proposal('Mara works at Larkspur', {
  kind: 'link',
  payload: {
    note: 'People/Mara Quill.md',
    property: 'company',
    link: '[[Larkspur Payroll]]',
    digest: 'd',
  },
});

const NONE_CHOSEN: RowSelection = { selected: new Set(), onToggle: vi.fn(), onToggleAll: vi.fn() };

function page(props: Partial<ProposalsSectionProps> = {}) {
  const handlers = {
    onAccept: vi.fn<(path: VaultPath, payload?: unknown) => void>(),
    onReject: vi.fn<(path: VaultPath) => void>(),
    onAcceptChoice: vi.fn<(picked: VaultPath, rest: readonly VaultPath[]) => void>(),
    onClearSelection: vi.fn(),
    onAcceptMany: vi.fn<(paths: readonly VaultPath[]) => void>(),
    onRejectMany: vi.fn<(paths: readonly VaultPath[]) => void>(),
    onDismissNotice: vi.fn(),
    onOpen: vi.fn<(path: VaultPath) => void>(),
    onOpenSource: vi.fn<(link: string) => void>(),
  };
  const section = (next: Partial<ProposalsSectionProps>) => (
    <ProposalsSection
      contents={{ open: [TASK, LINK], stranded: [], unreadable: [] }}
      error={null}
      notice={null}
      busy={null}
      problems={new Map()}
      selection={NONE_CHOSEN}
      {...handlers}
      {...next}
    />
  );
  const view = render(section(props));
  return {
    ...handlers,
    rerender: (next: Partial<ProposalsSectionProps>) =>
      view.rerender(section({ ...props, ...next })),
  };
}

const card = (name: RegExp) => screen.getByRole('region', { name });

describe('ProposalsSection', () => {
  it('lists each open proposal with what it would write, the line it cites and its maker', () => {
    page();
    const task = card(/^Task: Send Mara the payroll file/);
    expect(within(task).getByText('High').textContent).toBe('High confidence');
    expect(within(task).getByRole('button', { name: /2026-10-01 Standup#\^t0003/ })).toBeTruthy();
    expect(within(task).getByText('after-meeting · run 1')).toBeTruthy();
    expect(within(task).getByText('[[Mara Quill]], [[Tobias Fenn]]')).toBeTruthy();
    expect(within(card(/^Link: /)).getByText(/Adds \[\[Larkspur Payroll\]\] to/)).toBeTruthy();
    expect(screen.getByText(/^2 open proposals/)).toBeTruthy();
  });

  it('says a person proposed from a meeting joins it, and keeps that through an edit', async () => {
    const person = proposal('Mara Quill — Standup', {
      kind: 'person',
      source: '[[2026-10-06 Standup]]',
      payload: {
        title: 'Mara Quill',
        folder: 'People',
        properties: { email: 'mara@larkspur.example' },
        link_from: { note: 'Inbox/Meetings/2026-10-06 Standup.md', property: 'people' },
      },
    });
    const { onAccept } = page({ contents: { open: [person], stranded: [], unreadable: [] } });
    const shown = card(/^Person: Mara Quill/);
    expect(within(shown).getByText(/And adds it to/).textContent).toBe(
      'And adds it to people of 2026-10-06 Standup.',
    );
    await userEvent.click(within(shown).getByRole('button', { name: 'Edit' }));
    await userEvent.click(within(shown).getByRole('button', { name: 'Accept as edited' }));
    expect(onAccept.mock.calls[0]?.[1]).toMatchObject({
      link_from: { note: 'Inbox/Meetings/2026-10-06 Standup.md', property: 'people' },
    });
  });

  it('flags a proposal that cites no source', () => {
    page();
    expect(within(card(/^Link: /)).getByText('Cites no source')).toBeTruthy();
    expect(within(card(/^Task: /)).queryByText('Cites no source')).toBeNull();
  });

  it('accepts and rejects the proposal whose button was pressed', async () => {
    const handlers = page();
    await userEvent.click(within(card(/^Link: /)).getByRole('button', { name: 'Accept' }));
    await userEvent.click(within(card(/^Task: /)).getByRole('button', { name: 'Reject' }));
    expect(handlers.onAccept).toHaveBeenCalledWith(LINK.path, undefined);
    expect(handlers.onReject).toHaveBeenCalledWith(TASK.path);
  });

  it('opens the cited line, and the proposal itself', async () => {
    const handlers = page();
    const task = card(/^Task: /);
    await userEvent.click(within(task).getByRole('button', { name: /Standup#\^t0003/ }));
    await userEvent.click(within(task).getByRole('button', { name: 'Open proposal' }));
    expect(handlers.onOpenSource).toHaveBeenCalledWith('[[2026-10-01 Standup#^t0003]]');
    expect(handlers.onOpen).toHaveBeenCalledWith(TASK.path);
  });

  it('edits the payload before accepting, sending what was typed', async () => {
    const handlers = page();
    const task = card(/^Task: /);
    await userEvent.click(within(task).getByRole('button', { name: 'Edit' }));
    const title = within(task).getByRole('textbox', { name: 'Title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Send Mara the Q4 file');
    const status = within(task).getByRole('textbox', { name: 'status' });
    await userEvent.clear(status);
    await userEvent.type(status, 'doing');
    await userEvent.click(within(task).getByRole('button', { name: 'Accept as edited' }));

    expect(handlers.onAccept).toHaveBeenCalledWith(TASK.path, {
      title: 'Send Mara the Q4 file',
      folder: null,
      body: 'By Friday.',
      properties: { status: 'doing', people: ['[[Mara Quill]]', '[[Tobias Fenn]]'] },
    });
  });

  it('cancels an edit, accepting nothing and showing the payload again', async () => {
    const handlers = page();
    const task = card(/^Task: /);
    await userEvent.click(within(task).getByRole('button', { name: 'Edit' }));
    expect(within(task).getByRole('textbox', { name: 'Title' })).toBeTruthy();
    await userEvent.click(within(task).getByRole('button', { name: 'Cancel' }));
    expect(within(task).queryByRole('textbox', { name: 'Title' })).toBeNull();
    expect(within(task).getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(handlers.onAccept).not.toHaveBeenCalled();
  });

  it('edits only a link proposal’s link', async () => {
    const handlers = page();
    const link = card(/^Link: /);
    await userEvent.click(within(link).getByRole('button', { name: 'Edit' }));
    expect(within(link).getAllByRole('textbox')).toHaveLength(1);
    const field = within(link).getByRole('textbox', { name: 'Link' });
    await userEvent.clear(field);
    await userEvent.type(field, '[[[[Larkspur]]');
    await userEvent.click(within(link).getByRole('button', { name: 'Accept as edited' }));
    expect(handlers.onAccept).toHaveBeenCalledWith(
      LINK.path,
      expect.objectContaining({ link: '[[Larkspur]]', note: 'People/Mara Quill.md' }),
    );
  });

  it('says why an answer was refused, on that proposal', () => {
    page({ problems: new Map([[TASK.path, 'There is already a note at Send.md.']]) });
    expect(within(card(/^Task: /)).getByRole('alert').textContent).toBe(
      'There is already a note at Send.md.',
    );
    expect(within(card(/^Link: /)).queryByRole('alert')).toBeNull();
  });

  it('holds every answer while an accept is being undone', () => {
    page({ busy: 'undo' });
    for (const name of ['Accept', 'Edit', 'Reject']) {
      const buttons = screen.getAllByRole('button', { name });
      expect(buttons).toHaveLength(2);
      for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('says when there is nothing to answer, and lists what cannot be read', () => {
    page({
      contents: {
        open: [],
        stranded: [],
        unreadable: [
          { path: createVaultPath('Inbox/Proposals/Odd.md'), problem: 'It has no kind.' },
        ],
      },
    });
    expect(screen.getByText(/Nothing to answer/)).toBeTruthy();
    const unreadable = screen.getByRole('region', { name: 'Proposals that cannot be read' });
    expect(within(unreadable).getByText('It has no kind.')).toBeTruthy();
  });

  it('lists answered proposals still in the Inbox, each a click from its note', async () => {
    const handlers = page({
      contents: { open: [], stranded: [{ ...TASK, state: 'rejected' }], unreadable: [] },
    });
    const stranded = screen.getByRole('region', { name: 'Answered, still in the Inbox' });
    expect(within(stranded).getByText('Rejected')).toBeTruthy();
    await userEvent.click(
      within(stranded).getByRole('button', { name: 'Send Mara the payroll file' }),
    );
    expect(handlers.onOpen).toHaveBeenCalledWith(TASK.path);
  });

  it('marks a low-confidence proposal as one to check, and says why it was proposed', () => {
    const unsure = proposal('Send the contract', {
      kind: 'task',
      confidence: 'low',
      source: '[[Vendor contract call#^t0004]]',
      payload: {
        title: 'Send the contract',
        properties: { status: 'waiting', waiting_on: 'Lena Hart' },
      },
    });
    const why = 'There is no Person note for Lena Hart yet, so waiting_on holds the name as text.';
    page({
      contents: {
        open: [unsure, TASK],
        reasons: new Map([[unsure.path, why]]),
        stranded: [],
        unreadable: [],
      },
    });

    const low = screen.getByRole('region', { name: 'Task: Send the contract' });
    expect(within(low).getByText('Low').textContent).toBe('Low confidence');
    expect(low.classList.contains('proposal-row--low')).toBe(true);
    expect(within(low).getByText(why)).toBeTruthy();
    expect(within(low).getByText('Lena Hart')).toBeTruthy();
    // A sure one is not marked, and a proposal with no reason shows none.
    const sure = screen.getByRole('region', { name: 'Task: Send Mara the payroll file' });
    expect(sure.classList.contains('proposal-row--low')).toBe(false);
    expect(sure.querySelector('.proposal-row__why')).toBeNull();
    expect(low.querySelector('.proposal-row__why')).not.toBeNull();
  });

  it('lets the owner be set before accepting: an empty waiting_on is a field to fill in', async () => {
    const unowned = proposal('Go through the renewal', {
      kind: 'task',
      confidence: 'low',
      payload: { title: 'Go through the renewal', properties: { status: 'inbox', waiting_on: '' } },
    });
    const handlers = page({ contents: { open: [unowned], stranded: [], unreadable: [] } });
    const card = screen.getByRole('region', { name: 'Task: Go through the renewal' });

    await userEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    await userEvent.clear(within(card).getByLabelText('status'));
    await userEvent.type(within(card).getByLabelText('status'), 'waiting');
    await userEvent.type(within(card).getByLabelText('waiting_on'), 'Lena Hart');
    await userEvent.click(within(card).getByRole('button', { name: 'Accept as edited' }));

    expect(handlers.onAccept).toHaveBeenCalledWith(
      unowned.path,
      expect.objectContaining({ properties: { status: 'waiting', waiting_on: 'Lena Hart' } }),
    );
  });

  it('says why the folder could not be read', () => {
    page({ error: 'The vault could not be read.' });
    expect(screen.getByRole('alert').textContent).toBe('The vault could not be read.');
  });
});

describe('ProposalsSection — answering several at once (#168)', () => {
  const chosen = (paths: readonly string[]): RowSelection => ({
    selected: new Set(paths),
    onToggle: vi.fn(),
    onToggleAll: vi.fn(),
  });

  it('gives each card a box, and Select all over them', async () => {
    const selection = chosen([]);
    page({ selection });
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Select Send Mara the payroll file' }),
    );
    expect(selection.onToggle).toHaveBeenCalledWith(TASK.path, undefined);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(selection.onToggleAll).toHaveBeenCalledWith({
      paths: [TASK.path, LINK.path],
      select: true,
    });
  });

  it('extends the choice to a range on Shift-click, in the order the cards are listed', async () => {
    const selection = chosen([TASK.path]);
    page({ selection });
    const user = userEvent.setup();
    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('checkbox', { name: /^Select .*Larkspur/ }));
    await user.keyboard('{/Shift}');
    expect(selection.onToggle).toHaveBeenCalledWith(LINK.path, { order: [TASK.path, LINK.path] });
  });

  it('accepts or rejects the chosen ones together, and lets them go', async () => {
    const handlers = page({ selection: chosen([TASK.path, LINK.path]) });
    expect(screen.getByRole('status').textContent).toBe('2 selected');
    expect(screen.getByRole('toolbar', { name: 'Chosen proposals' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Accept 2 proposals' }));
    expect(handlers.onAcceptMany).toHaveBeenCalledWith([TASK.path, LINK.path]);
    await userEvent.click(screen.getByRole('button', { name: 'Reject 2 proposals' }));
    expect(handlers.onRejectMany).toHaveBeenCalledWith([TASK.path, LINK.path]);
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(handlers.onClearSelection).toHaveBeenCalledOnce();
  });

  it('holds the answers to the chosen ones while an accept is being undone', () => {
    page({ selection: chosen([TASK.path]), busy: 'undo' });
    const accept = screen.getByRole('button', { name: 'Accept proposal' }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
  });

  it('offers no choosing over a single proposal', () => {
    page({ contents: { open: [TASK], stranded: [], unreadable: [] } });
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('ProposalsSection — a failure stays until read (review)', () => {
  afterEach(() => vi.useRealTimers());

  // What went well is said in the window's toast, with its Undo (UI v2, slice 15); a
  // failure with nothing to take back is said here, and never goes by itself.
  const FAILED = 'Mara Quill’s task was changed since it was made, so it was left as it is.';

  it('keeps a failure up, however long, until it is dismissed', async () => {
    vi.useFakeTimers();
    const handlers = page({ notice: FAILED });
    act(() => vi.advanceTimersByTime(120_000));
    expect(handlers.onDismissNotice).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('was changed since it was made');

    vi.useRealTimers();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(handlers.onDismissNotice).toHaveBeenCalledTimes(1);
  });

  it('offers nothing beside it but Dismiss: there is nothing to take back', () => {
    page({ notice: FAILED });
    const notice = screen.getByRole('status');
    expect(
      within(notice)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['×']);
  });
});

describe('ProposalsSection — the focus after an answer by keyboard (review)', () => {
  it('moves to the next card once the answered one has left, then to the heading', async () => {
    const handlers = page();
    act(() =>
      within(card(/^Task: /))
        .getByRole('button', { name: 'Accept' })
        .focus(),
    );
    await userEvent.keyboard('{Enter}');
    expect(handlers.onAccept).toHaveBeenCalledOnce();
    handlers.rerender({ contents: { open: [LINK], stranded: [], unreadable: [] } });

    const focused = document.activeElement;
    expect(focused?.tagName).toBe('BUTTON');
    expect(card(/^Link: /).contains(focused)).toBe(true);
    expect(card(/^Link: /).querySelector('button')).toBe(focused);

    act(() =>
      within(card(/^Link: /))
        .getByRole('button', { name: 'Reject' })
        .focus(),
    );
    await userEvent.keyboard('{Enter}');
    handlers.rerender({ contents: { open: [], stranded: [], unreadable: [] } });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Proposals' }));
  });

  it('leaves the focus where the person moved it before the card left', async () => {
    const handlers = page();
    act(() =>
      within(card(/^Task: /))
        .getByRole('button', { name: 'Accept' })
        .focus(),
    );
    await userEvent.keyboard('{Enter}');
    const elsewhere = within(card(/^Link: /)).getByRole('button', { name: 'Reject' });
    act(() => elsewhere.focus());
    handlers.rerender({ contents: { open: [LINK], stranded: [], unreadable: [] } });
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('proposalsToShow — while the last answers are written (review)', () => {
  it('keeps the section, and its heading for the focus, while answers are still being written', () => {
    const none: ProposalsSectionProps = {
      contents: { open: [], stranded: [], unreadable: [] },
      error: null,
      notice: null,
      busy: null,
      problems: new Map(),
      onAccept: vi.fn(),
      onReject: vi.fn(),
      onAcceptChoice: vi.fn(),
      selection: NONE_CHOSEN,
      onClearSelection: vi.fn(),
      onAcceptMany: vi.fn(),
      onRejectMany: vi.fn(),
      onDismissNotice: vi.fn(),
      onOpen: vi.fn(),
      onOpenSource: vi.fn(),
    };
    expect(proposalsToShow(none)).toBe(false);
    expect(proposalsToShow({ ...none, answering: true })).toBe(true);
  });

  it('keeps the section, to say nothing is left, once the last one was answered here', () => {
    const none = {
      contents: { open: [], stranded: [], unreadable: [] },
      error: null,
      notice: null,
    } as unknown as ProposalsSectionProps;
    expect(proposalsToShow(none)).toBe(false);
    expect(proposalsToShow({ ...none, answered: true })).toBe(true);
  });
});

describe('ProposalsSection — the same proposal made twice', () => {
  const twin = (name: string, to = '[[Mara Quill]]') =>
    proposal(name, {
      kind: 'link',
      confidence: 'high',
      source: '[[2026-10-01 Standup#^t0003]]',
      payload: {
        note: 'Inbox/Meetings/2026-10-01 Standup.md',
        property: 'owner',
        link: to,
        digest: null,
      },
    });
  const FIRST = twin('Mara 1');
  const SECOND = twin('Mara 2', '[[mara quill|Mara]]');
  const contents = { open: [FIRST, SECOND], stranded: [], unreadable: [] };

  it('lists the copies as one card, and accepting it rejects the copies behind it', async () => {
    const handlers = page({ contents });
    expect(screen.getAllByRole('region', { name: /^Link: / })).toHaveLength(1);
    await userEvent.click(within(card(/^Link: /)).getByRole('button', { name: 'Accept' }));
    expect(handlers.onAcceptChoice).toHaveBeenCalledWith(FIRST.path, [SECOND.path]);
    expect(handlers.onAccept).not.toHaveBeenCalled();
  });

  it('rejecting the card rejects every copy', async () => {
    const handlers = page({ contents });
    await userEvent.click(within(card(/^Link: /)).getByRole('button', { name: 'Reject' }));
    expect(handlers.onRejectMany).toHaveBeenCalledWith([FIRST.path, SECOND.path]);
  });

  it('Accept all high confidence accepts the first once and rejects its copies after it', async () => {
    const handlers = page({ contents });
    await userEvent.click(screen.getByRole('button', { name: 'Accept all high confidence' }));
    expect(handlers.onAcceptChoice).toHaveBeenCalledWith(FIRST.path, [SECOND.path]);
    expect(handlers.onAcceptMany).not.toHaveBeenCalled();
  });
});

describe('a dashboard or view proposal (P32-05)', () => {
  const DASHBOARD = proposal('Larkspur Payroll', {
    kind: 'dashboard',
    made_by: 'Claude, in the chat',
    payload: {
      title: 'Larkspur Payroll',
      spec: {
        widgets: [
          { kind: 'bar', title: 'By status', type: 'task', groupBy: 'status' },
          { kind: 'number', type: 'project' },
        ],
      },
    },
  });
  const VIEW = proposal('Open tasks', {
    kind: 'view',
    payload: { title: 'Open tasks', spec: { type: 'task', layout: 'board' } },
  });

  it('shows its kind as a chip, what it would draw, and where Accept makes it', () => {
    page({ contents: { open: [DASHBOARD, VIEW], stranded: [], unreadable: [] } });

    const row = card(/^Dashboard: Larkspur Payroll$/);
    const chip = within(row).getByText('Dashboard');
    expect(chip.getAttribute('data-kind')).toBe('dashboard');
    const drawn = within(row).getByLabelText('What it would write');
    expect(
      within(drawn)
        .getAllByRole('term')
        .map((term) => term.textContent),
    ).toEqual(['bar', 'number']);
    expect(
      within(drawn)
        .getAllByRole('definition')
        .map((each) => each.textContent),
    ).toEqual(['By status', 'project']);
    expect(row.textContent).toContain('Accepting makes it in .atlas/dashboards.');

    const view = card(/^View: Open tasks$/);
    expect(within(view).getByText('View').getAttribute('data-kind')).toBe('view');
    expect(view.textContent).toContain('typetask');
    expect(view.textContent).toContain('layoutboard');
    expect(view.textContent).toContain('Accepting makes it in .atlas/views.');
  });

  it('edits only its name before Accept, and accepts the spec unchanged under it', async () => {
    const { onAccept } = page({ contents: { open: [DASHBOARD], stranded: [], unreadable: [] } });
    const row = card(/^Dashboard: Larkspur Payroll$/);

    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    expect(within(row).getAllByRole('textbox')).toHaveLength(1);
    const name = within(row).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Payroll board');
    await userEvent.click(within(row).getByRole('button', { name: 'Accept as edited' }));

    expect(onAccept).toHaveBeenCalledWith(DASHBOARD.path, {
      title: 'Payroll board',
      spec: DASHBOARD.kind === 'dashboard' ? DASHBOARD.payload.spec : null,
    });
  });
});

describe('a dashboard proposal that runs a query (PR #549 attack)', () => {
  const SQL =
    "SELECT title, status FROM notes WHERE type = 'task' AND status <> 'done' ORDER BY due LIMIT 25";
  const QUERY = 'FROM task WHERE status != "done" SORT due';
  const QUERYING = proposal('Orchard queries', {
    kind: 'dashboard',
    made_by: 'Claude, in the chat',
    payload: {
      title: 'Orchard queries',
      spec: {
        widgets: [
          { kind: 'sql', title: 'Open by due', sql: SQL, show: 'table' },
          { kind: 'query', title: 'Still open', query: QUERY },
        ],
      },
    },
  });

  it('shows each sql widget’s full statement before Accept', () => {
    page({ contents: { open: [QUERYING], stranded: [], unreadable: [] } });

    expect(card(/^Dashboard: Orchard queries$/).textContent).toContain(SQL);
  });

  it('shows each query widget’s full query before Accept', () => {
    page({ contents: { open: [QUERYING], stranded: [], unreadable: [] } });

    expect(card(/^Dashboard: Orchard queries$/).textContent).toContain(QUERY);
  });
});

describe('a dashboard proposal shows what Accept writes (P32-05)', () => {
  const SQL = "SELECT title FROM notes WHERE type = 'task'\n  AND status <> 'done'";
  const FILTERED = proposal('Filtered', {
    kind: 'dashboard',
    payload: {
      title: 'Filtered',
      spec: {
        widgets: [
          {
            kind: 'number',
            type: 'task',
            title: 'Open',
            filters: [{ key: 'status', operator: 'is', value: 'inbox' }],
          },
          { kind: 'sql', title: 'Raw', sql: SQL, show: 'table' },
        ],
      },
    },
  });

  it('lists each widget’s filters, and its SQL whole in a code block', () => {
    page({ contents: { open: [FILTERED], stranded: [], unreadable: [] } });
    const row = card(/^Dashboard: Filtered$/);

    expect(within(row).getByText('status is inbox')).toBeTruthy();
    const code = row.querySelector('code.proposal-row__spec-query');
    expect(code?.textContent).toBe(SQL);
  });
});
