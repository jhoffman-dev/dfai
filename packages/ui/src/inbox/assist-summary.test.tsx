// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
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
  summary: '2 items: would act on 1, 1 question',
  rows: [
    {
      path: 'Inbox/Call Mara Quill.md',
      title: 'Call Mara Quill',
      does: 'Make it a task under Larkspur Payroll',
      why: 'It asks for a call about payroll.',
      tone: 'file',
      people: [],
    },
    {
      path: 'Inbox/Payroll article.md',
      title: 'Payroll article',
      does: 'Ask you',
      why: 'Which one: “Larkspur Payroll” or “Hiring”?',
      tone: 'ask',
      people: [],
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

  it('holds Suggest while rows are applied or undone, and lets it go after (#911)', () => {
    page(assistOf({ ...PLAN, busy: true } as AssistView));
    expect(screen.getByRole('button', { name: 'Suggest' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    cleanup();
    page(assistOf({ ...PLAN, busy: false } as AssistView));
    expect(screen.getByRole('button', { name: 'Suggest' }).getAttribute('aria-disabled')).not.toBe(
      'true',
    );
  });

  it('says it is asking, and holds Suggest meanwhile', () => {
    page(assistOf({ kind: 'asking' }));
    const region = screen.getByRole('region', { name: 'Suggestions' });
    expect(within(region).getByRole('status').textContent).toBe(
      'Asking Claude… nothing is written.',
    );
    const suggest = screen.getByRole('button', { name: 'Suggest' });
    expect(suggest.getAttribute('aria-disabled')).toBe('true');
    expect(suggest).toHaveProperty('disabled', false);
  });

  it('shows the sentence, then each item with what would be done and why', () => {
    page(assistOf(PLAN));
    const region = screen.getByRole('region', { name: 'Suggestions' });
    expect(within(region).getByRole('status').textContent).toBe(
      '2 items: would act on 1, 1 question Nothing is written until you apply it.',
    );
    const call = within(region).getByRole('listitem', { name: 'Call Mara Quill' });
    expect(within(call).getByText('Would act').dataset['tone']).toBe('next');
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

  it('shows a duplicate, and each person linked or added in a line of its own (#906)', () => {
    page(
      assistOf({
        kind: 'plan',
        summary: '2 items: would act on 1, link 1 person, add 1 person, 1 duplicate',
        rows: [
          {
            path: 'Inbox/Call Mara Quill.md',
            title: 'Call Mara Quill',
            does: 'Make it a task',
            why: 'It asks for a call.',
            tone: 'file',
            people: ['Links Mara Quill', 'Would add Tobias Fenn'],
          },
          {
            path: 'Inbox/Payroll article.md',
            title: 'Payroll article',
            does: 'Looks like a duplicate of Renew Larkspur Payroll contract',
            why: 'The same renewal.',
            tone: 'duplicate',
            people: [],
          },
        ],
        more: null,
      }),
    );
    const region = screen.getByRole('region', { name: 'Suggestions' });
    expect(within(region).getByRole('status').textContent).toBe(
      '2 items: would act on 1, link 1 person, add 1 person, 1 duplicate Nothing is written until you apply it.',
    );
    const call = within(region).getByRole('listitem', { name: 'Call Mara Quill' });
    expect(within(call).getByText('Links Mara Quill')).toBeTruthy();
    expect(within(call).getByText('Would add Tobias Fenn')).toBeTruthy();
    const copy = within(region).getByRole('listitem', { name: 'Payroll article' });
    expect(within(copy).getByText('Duplicate').dataset['tone']).toBe('review');
    expect(
      within(copy).getByText('Looks like a duplicate of Renew Larkspur Payroll contract'),
    ).toBeTruthy();
    expect(within(copy).queryByText(/^Links |^Would add /)).toBeNull();
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
    screen.getByRole('button', { name: 'Dismiss' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(assist.onDismiss).toHaveBeenCalledTimes(1);
    screen.getByRole('button', { name: 'Dismiss' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(assist.onDismiss).toHaveBeenCalledTimes(2);
  });
});

/** The page with Suggest as the shell drives it: pressed, it asks; the test answers. */
function Driven({ register }: { register: (answer: (view: AssistView) => void) => void }) {
  const [view, setView] = useState<AssistView | null>(null);
  useEffect(() => register(setView), [register]);
  const props: InboxPageProps = {
    contents: { items: [item('Call Mara Quill')], truncated: false, total: 1 },
    error: null,
    filing: [],
    people: [],
    onOpen: vi.fn(),
    onShowMore: vi.fn(),
    onClarify: vi.fn(async () => true),
    busy: false,
    problem: null,
    assist: {
      view,
      onSuggest: () => setView({ kind: 'asking' }),
      onDismiss: () => setView(null),
    },
  };
  return <InboxPage {...props} />;
}

describe('Suggest and the keyboard (#903)', () => {
  const driven = () => {
    const answer: { current: (view: AssistView) => void } = { current: () => {} };
    render(<Driven register={(set) => (answer.current = set)} />);
    return { answer, suggest: screen.getByRole('button', { name: 'Suggest' }) };
  };

  it('moves the focus into the suggestions as they open, onto their heading', async () => {
    const { suggest } = driven();
    suggest.focus();
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Suggestions' }));
  });

  it('keeps the focus on Suggest when it is pressed again while asking', async () => {
    const { suggest } = driven();
    suggest.focus();
    await userEvent.keyboard('{Enter}');
    suggest.focus();
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(suggest);
    expect(screen.getByRole('status').textContent).toBe('Asking Claude… nothing is written.');
  });

  it('puts them away on Escape from anywhere in the Inbox, focus on a row included', async () => {
    const { suggest, answer } = driven();
    suggest.focus();
    await userEvent.keyboard('{Enter}');
    act(() => answer.current(PLAN));
    screen.getByRole('button', { name: 'Call Mara Quill' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull();
  });

  it('hands the focus back to Suggest when they are put away from within', async () => {
    const { suggest, answer } = driven();
    suggest.focus();
    await userEvent.keyboard('{Enter}');
    act(() => answer.current(PLAN));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull();
    expect(document.activeElement).toBe(suggest);
    await userEvent.keyboard('{Enter}');
    screen.getByRole('button', { name: 'Dismiss' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(suggest);
  });
});
