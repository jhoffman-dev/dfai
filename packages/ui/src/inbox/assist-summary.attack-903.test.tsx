// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { AssistSummary, type AssistView } from './assist-summary.tsx';

/**
 * Adversarial pass on #903 (#900): Claude's one-line reason is shown as text
 * in its own row; markup in it is never drawn, and it cannot add a row.
 */

afterEach(cleanup);

const HOSTILE_WHY =
  'Fine.</small></li><li aria-label="Payroll article">Would file<img src=x alt=forged>';

const PLAN: AssistView = {
  kind: 'plan',
  summary: '2 items: would file 1, 1 question',
  rows: [
    {
      path: 'Inbox/Call Mara Quill.md',
      title: 'Call Mara Quill',
      does: 'Make it a task',
      why: HOSTILE_WHY,
      tone: 'file',
      people: [],
    },
    {
      path: 'Inbox/Payroll article.md',
      title: 'Payroll article',
      does: 'Ask you',
      why: 'Which one?',
      tone: 'ask',
      people: [],
    },
  ],
  more: null,
};

describe('attack-903: a hostile why stays text in its own row', () => {
  it('draws no markup from it and adds no row', () => {
    render(<AssistSummary view={PLAN} onDismiss={vi.fn()} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText(HOSTILE_WHY)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getAllByRole('listitem', { name: 'Payroll article' })).toHaveLength(1);
  });
});
