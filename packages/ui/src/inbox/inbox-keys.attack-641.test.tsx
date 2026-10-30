// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, type InboxItem, type InboxTask } from '@dfai/domain';
import { InboxPage, type InboxContents, type InboxPageProps } from '../inbox-page.tsx';
import type { RelationChoice } from '../properties-panel.tsx';

/** Adversarial pass on PR #641 (#109): the Inbox's keys once its last row has gone. */

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
    onUndo: vi.fn(async () => null),
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

describe('InboxPage keys — attack PR #641', () => {
  // The list unmounts once empty and its key handler with it: the focus is on the document, and U reaches nothing.
  it.fails(
    'takes the last clarification back on U once the row it took was the Inbox’s last',
    async () => {
      const view = page({
        contents: contentsOf(['Call the bank']),
        onUndo: vi.fn(async () => createVaultPath('Inbox/Call the bank.md')),
      });
      focusRow('Call the bank');
      await userEvent.keyboard('n');
      expect(clarified(view.onClarify)).toHaveLength(1);
      view.rerender({ contents: contentsOf([]) });
      await act(async () => {
        await userEvent.keyboard('u');
      });
      expect(view.onUndo).toHaveBeenCalledTimes(1);
    },
  );
});
