// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath, type InboxItem } from '@dfai/domain';
import { InboxPage, type InboxAssistProps, type InboxPageProps } from '../inbox-page.tsx';
import type { AssistView } from './assist-summary.tsx';

/**
 * #900: Suggest on the Inbox. Its button is in the page's bar; once pressed,
 * the sentence, each item with what would be done and why, and Dismiss —
 * all by keyboard. Until it is pressed, the page draws nothing more.
 */

afterEach(cleanup);

const item = (title: string): InboxItem => ({
  path: createVaultPath(`Inbox/${title}.md`),
  title,
  type: null,
  arrivedIn: '',
  importOutcome: null,
  importError: null,
  task: null,
});

const PLAN: AssistView = {
  kind: 'plan',
  summary: '2 items: would file 1, 1 question',
  rows: [
    {
      path: 'Inbox/Call Mara Quill.md',
      title: 'Call Mara Quill',
      does: 'Make it a task under Larkspur Payroll',
      why: 'It asks for a call about payroll.',
      tone: 'file',
    },
    {
      path: 'Inbox/Payroll article.md',
      title: 'Payroll article',
      does: 'Ask you',
      why: 'Which one: “Larkspur Payroll” or “Hiring”?',
      tone: 'ask',
    },
  ],
  more: '3 more items were not looked at: one ask looks at 10.',
};

function page(assist: InboxAssistProps | null) {
  const props: InboxPageProps = {
    contents: {
      items: [item('Call Mara Quill'), item('Payroll article')],
      truncated: false,
      total: 2,
    },
    error: null,
    filing: [],
    people: [],
    onOpen: vi.fn(),
    onShowMore: vi.fn(),
    onClarify: vi.fn(async () => true),
    busy: false,
    problem: null,
    assist,
  };
  return render(<InboxPage {...props} />);
}

const assistOf = (view: AssistView | null): InboxAssistProps => ({
  view,
  onSuggest: vi.fn(),
  onDismiss: vi.fn(),
});

describe('Suggest on the Inbox', () => {
  it('offers Suggest in the bar and draws nothing more until it is pressed', async () => {
    const assist = assistOf(null);
    page(assist);
    const suggest = screen.getByRole('button', { name: 'Suggest' });
    expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull();
    suggest.focus();
    await userEvent.keyboard('{Enter}');
    expect(assist.onSuggest).toHaveBeenCalledTimes(1);
  });

  it('is not offered where Claude is not', () => {
    page(null);
    expect(screen.getByRole('heading', { name: /To clarify/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Suggest' })).toBeNull();
  });

  it('says it is asking, and holds Suggest meanwhile', () => {
    page(assistOf({ kind: 'asking' }));
    const region = screen.getByRole('region', { name: 'Suggestions' });
    expect(within(region).getByRole('status').textContent).toBe(
      'Asking Claude… nothing is written.',
    );
    expect(screen.getByRole('button', { name: 'Suggest' })).toHaveProperty('disabled', true);
  });

  it('shows the sentence, then each item with what would be done and why', () => {
    page(assistOf(PLAN));
    const region = screen.getByRole('region', { name: 'Suggestions' });
    expect(within(region).getByRole('status').textContent).toBe(
      '2 items: would file 1, 1 question Nothing is written.',
    );
    const call = within(region).getByRole('listitem', { name: 'Call Mara Quill' });
    expect(within(call).getByText('Would file').dataset['tone']).toBe('next');
    expect(within(call).getByText('Make it a task under Larkspur Payroll')).toBeTruthy();
    expect(within(call).getByText('It asks for a call about payroll.')).toBeTruthy();
    const article = within(region).getByRole('listitem', { name: 'Payroll article' });
    expect(within(article).getByText('Question').dataset['tone']).toBe('waiting');
    expect(within(article).getByText('Which one: “Larkspur Payroll” or “Hiring”?')).toBeTruthy();
    expect(
      within(region).getByText('3 more items were not looked at: one ask looks at 10.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Suggest' })).toHaveProperty('disabled', false);
  });

  it('says plainly why not, in place of a plan', () => {
    const message = 'Not now: Claude can’t be reached. Nothing was asked; nothing changed.';
    page(assistOf({ kind: 'not-now', message }));
    const region = screen.getByRole('region', { name: 'Suggestions' });
    expect(within(region).getByRole('status').textContent).toBe(message);
    expect(within(region).queryByRole('list')).toBeNull();
  });

  it('is dismissed by its button or by Escape, from the keyboard', async () => {
    const assist = assistOf(PLAN);
    page(assist);
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    dismiss.focus();
    await userEvent.keyboard('{Enter}');
    expect(assist.onDismiss).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    expect(assist.onDismiss).toHaveBeenCalledTimes(2);
  });
});
