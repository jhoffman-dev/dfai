// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createVaultPath, type InboxItem, type InboxTask } from '@dfai/domain';
import { InboxPage, type InboxPageProps } from '../inbox-page.tsx';

/** #928: a task's due time beside its due on an Inbox row, only where it names one. */
const CAPTURED: InboxTask = {
  status: 'inbox',
  project: null,
  waitingOn: null,
  waitingOnNames: '',
  defer: null,
  due: '2026-12-04',
};

const item = (title: string, task: InboxTask): InboxItem => ({
  path: createVaultPath(`Inbox/${title}.md`),
  title,
  type: 'task',
  arrivedIn: '',
  importOutcome: null,
  importError: null,
  task,
});

function page() {
  const props: InboxPageProps = {
    contents: {
      items: [
        item('Call Mara Quill', { ...CAPTURED, dueTime: '15:30' }),
        item('Pay Larkspur Payroll', CAPTURED),
      ],
      truncated: false,
      total: 2,
    },
    error: null,
    filing: [],
    people: [],
    onOpen: vi.fn(),
    onShowMore: vi.fn(),
    onClarify: vi.fn(async () => true),
    onUndo: vi.fn(async () => null),
    busy: false,
    problem: null,
  };
  render(<InboxPage {...props} />);
}

const rowOf = (title: string) =>
  screen.getByRole('button', { name: title }).closest('tr') as HTMLElement;

afterEach(() => cleanup());

describe('an Inbox row, a due with a time (#928)', () => {
  it('shows the time beside the due’s day, and none for a date-only due', () => {
    page();
    const timed = rowOf('Call Mara Quill');
    expect(
      (timed.querySelector('input[aria-label="Call Mara Quill is due"]') as HTMLInputElement).value,
    ).toBe('2026-12-04');
    expect(timed.querySelector('.due-time')?.textContent).toBe(' at 15:30');
    const plain = rowOf('Pay Larkspur Payroll');
    expect(plain.querySelector('input[aria-label="Pay Larkspur Payroll is due"]')).not.toBeNull();
    expect(plain.querySelector('.due-time')).toBeNull();
  });
});
