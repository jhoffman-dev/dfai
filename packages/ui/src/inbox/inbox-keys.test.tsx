// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, type InboxItem, type InboxTask } from '@dfai/domain';
import { InboxPage, type InboxContents, type InboxPageProps } from '../inbox-page.tsx';
import type { RelationChoice } from '../properties-panel.tsx';

/** #109: keyboard triage on the Inbox — moving, opening, X, Undo and the hint strip. */

const CAPTURED: InboxTask = {
  status: 'inbox',
  project: null,
  waitingOn: null,
  waitingOnNames: '',
  defer: null,
  due: null,
};

const TITLES = [
  'Call the bank',
  'Chase the quote',
  'Learn the cello',
  'Renew the passport',
  'Fix the gate',
];

const task = (title: string): InboxItem => ({
  path: createVaultPath(`Inbox/${title}.md`),
  title,
  type: 'task',
  arrivedIn: '',
  importOutcome: null,
  importError: null,
  task: CAPTURED,
});

const contentsOf = (titles: readonly string[]): InboxContents => ({
  items: titles.map(task),
  truncated: false,
  total: titles.length,
});

const FILING: readonly RelationChoice[] = [
  { path: 'Projects/Larkspur Payroll.md', title: 'Larkspur Payroll', type: 'project' },
];
const PEOPLE: readonly RelationChoice[] = [
  { path: 'People/Mara Quill.md', title: 'Mara Quill', type: 'person' },
];

function page(overrides: Partial<InboxPageProps> = {}) {
  const props: InboxPageProps = {
    contents: contentsOf(TITLES),
    error: null,
    filing: FILING,
    people: PEOPLE,
    onOpen: vi.fn(),
    onShowMore: vi.fn(),
    onClarify: vi.fn(async () => true),
    onUndo: vi.fn(),
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
const focusRow = (title: string) => act(() => rowOf(title).focus());
const clarified = (onClarify: InboxPageProps['onClarify']) =>
  (onClarify as ReturnType<typeof vi.fn>).mock.calls.map(([args]) => args);

describe('InboxPage — keyboard triage (#109)', () => {
  it('moves the focus a row with J and K, and with the arrows, staying put at either end', async () => {
    page();
    focusRow('Call the bank');
    await userEvent.keyboard('j');
    expect(document.activeElement).toBe(rowOf('Chase the quote'));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowOf('Learn the cello'));
    await userEvent.keyboard('k');
    expect(document.activeElement).toBe(rowOf('Chase the quote'));
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(document.activeElement).toBe(rowOf('Call the bank'));

    focusRow('Fix the gate');
    await userEvent.keyboard('j');
    expect(document.activeElement).toBe(rowOf('Fix the gate'));
  });

  it('shows the focus on the row the keys act on, and only on that row', async () => {
    page();
    focusRow('Call the bank');
    await userEvent.keyboard('j');
    expect(rowOf('Chase the quote').className).toContain('inbox__row--focused');
    expect(rowOf('Call the bank').className).not.toContain('inbox__row--focused');
    // Its keys are drawn on it alone, each naming its shortcut.
    expect(
      within(rowOf('Chase the quote'))
        .getByRole('button', { name: 'Done, key D' })
        .getAttribute('aria-keyshortcuts'),
    ).toBe('d x');
    expect(
      within(rowOf('Call the bank')).queryByRole('button', { name: 'Done, key D' }),
    ).toBeNull();
  });

  it('opens the focused row’s note on Return — but Return on a key button presses that button', async () => {
    const { onOpen, onClarify } = page();
    focusRow('Learn the cello');
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith('Inbox/Learn the cello.md');

    act(() => rowOf('Fix the gate').focus());
    act(() =>
      within(rowOf('Fix the gate')).getByRole('button', { name: 'Someday, key S' }).focus(),
    );
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(clarified(onClarify)).toEqual([
      { path: 'Inbox/Fix the gate.md', clarification: { status: 'someday' } },
    ]);
  });

  it('ticks a row done with X, as D does, and moves the focus to the next row', async () => {
    const { onClarify } = page();
    focusRow('Chase the quote');
    await userEvent.keyboard('x');
    expect(clarified(onClarify)).toEqual([
      { path: 'Inbox/Chase the quote.md', clarification: { status: 'archive' } },
    ]);
    expect(document.activeElement).toBe(rowOf('Learn the cello'));
  });

  it('takes the last clarification back on U or ⌘Z, and the row has the focus again once it is back', async () => {
    const view = page();
    focusRow('Call the bank');
    await userEvent.keyboard('n');
    view.rerender({ contents: contentsOf(TITLES.slice(1)) });
    expect(document.activeElement).toBe(rowOf('Chase the quote'));

    await userEvent.keyboard('u');
    expect(view.onUndo).toHaveBeenCalledTimes(1);
    view.rerender({ contents: contentsOf(TITLES) });
    expect(document.activeElement).toBe(rowOf('Call the bank'));

    await userEvent.keyboard('{Meta>}z{/Meta}');
    expect(view.onUndo).toHaveBeenCalledTimes(2);
    // ⇧⌘Z is redo, never an undo.
    await userEvent.keyboard('{Meta>}{Shift>}z{/Shift}{/Meta}');
    expect(view.onUndo).toHaveBeenCalledTimes(2);
    expect(view.onClarify).toHaveBeenCalledTimes(1);
  });

  it('holds U back while a clarification is still being written, then takes it back (PR #641 review)', async () => {
    let settle: (done: boolean) => void = () => {};
    const onClarify = vi.fn(() => new Promise<boolean>((done) => (settle = done)));
    const view = page({ onClarify });
    focusRow('Call the bank');
    await userEvent.keyboard('n');
    view.rerender({ contents: contentsOf(TITLES.slice(1)) });
    await userEvent.keyboard('u');
    expect(view.onUndo).not.toHaveBeenCalled();
    await act(async () => settle(true));
    await userEvent.keyboard('u');
    expect(view.onUndo).toHaveBeenCalledTimes(1);
  });

  it('fires nothing while a field, a picker or a list has the focus: the letters are typed', async () => {
    const { onClarify, onUndo, onOpen } = page();
    const row = rowOf('Learn the cello');
    focusRow('Learn the cello');
    const project = within(row).getByRole('combobox', { name: 'File Learn the cello under' });
    await userEvent.click(project);
    await userEvent.keyboard('jkxnu{Enter}');
    expect(document.activeElement).toBe(project);
    const status = within(row).getByRole('combobox', { name: 'Status of Learn the cello' });
    act(() => status.focus());
    await userEvent.keyboard('xu');
    expect(document.activeElement).toBe(status);
    expect(onClarify).not.toHaveBeenCalled();
    expect(onUndo).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('lists the keys above the rows, read by a screen reader as a note', () => {
    page();
    const strip = screen.getByRole('note', { name: 'Keys for the Inbox' });
    expect(strip.getAttribute('aria-hidden')).toBeNull();
    const hints = [...strip.querySelectorAll('.key-hints__hint')].map((hint) => hint.textContent);
    expect(hints).toEqual([
      'JKMove',
      '↵Open',
      'NNext',
      'WWaiting',
      'SSomeday',
      'TSchedule',
      'PProject',
      'DXDone',
      'UUndo',
    ]);
  });

  it('works five rows by keys alone — moving past one, acting on the rest, and taking one back', async () => {
    const view = page();
    const left: string[] = [];
    const leave = (title: string) => {
      left.push(title);
      view.rerender({ contents: contentsOf(TITLES.filter((each) => !left.includes(each))) });
    };
    focusRow('Call the bank');
    await userEvent.keyboard('j'); // past Call the bank
    await userEvent.keyboard('w');
    leave('Chase the quote');
    expect(document.activeElement).toBe(rowOf('Learn the cello'));
    await userEvent.keyboard('s');
    leave('Learn the cello');
    await userEvent.keyboard('x');
    leave('Renew the passport');
    expect(document.activeElement).toBe(rowOf('Fix the gate'));
    await userEvent.keyboard('k{Enter}');
    expect(view.onOpen).toHaveBeenCalledWith('Inbox/Call the bank.md');
    await userEvent.keyboard('u');
    left.pop();
    view.rerender({ contents: contentsOf(TITLES.filter((each) => !left.includes(each))) });
    expect(document.activeElement).toBe(rowOf('Renew the passport'));
    expect(clarified(view.onClarify)).toEqual([
      { path: 'Inbox/Chase the quote.md', clarification: { status: 'waiting' } },
      { path: 'Inbox/Learn the cello.md', clarification: { status: 'someday' } },
      { path: 'Inbox/Renew the passport.md', clarification: { status: 'archive' } },
    ]);
  });
});
