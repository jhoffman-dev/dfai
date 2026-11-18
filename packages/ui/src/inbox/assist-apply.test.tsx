// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssistSummary, type AssistActions, type AssistView } from './assist-summary.tsx';
import type { AssistRowAction, AssistRowView } from './assist-row.tsx';

/**
 * #909: Apply and Undo on the suggestions, per row and for all, by keyboard.
 * The panel decides nothing: it shows each row as it is said, and hands the
 * presses on.
 */

afterEach(cleanup);

const row = (
  title: string,
  action: AssistRowAction,
  tone: AssistRowView['tone'] = 'file',
): AssistRowView => ({
  path: `Inbox/${title}.md`,
  title,
  does: 'Make it a task under Larkspur Payroll',
  why: 'It asks for a call.',
  tone,
  people: [],
  action,
});

const plan = (
  rows: readonly AssistRowView[],
  extra: Partial<Extract<AssistView, { kind: 'plan' }>> = {},
): AssistView => ({
  kind: 'plan',
  summary: '2 items: would act on 1, 1 question',
  rows,
  more: null,
  canApplyAll: true,
  canUndoAll: false,
  busy: false,
  said: '',
  ...extra,
});

function actions(): AssistActions & { [K in keyof AssistActions]: ReturnType<typeof vi.fn> } {
  return { onApply: vi.fn(), onUndo: vi.fn(), onApplyAll: vi.fn(), onUndoAll: vi.fn() };
}

const show = (view: AssistView, given = actions()) => {
  const shown = render(<AssistSummary view={view} onDismiss={() => undefined} actions={given} />);
  return { ...shown, given, region: screen.getByRole('region', { name: 'Suggestions' }) };
};

describe('Apply on the suggestions', () => {
  it('offers Apply on a row that can be applied, and nothing on a question', async () => {
    const { given, region } = show(
      plan([row('Call Mara', { kind: 'apply', said: null }), row('Junk', { kind: 'none' }, 'ask')]),
    );
    const call = within(region).getByRole('listitem', { name: 'Call Mara' });
    await userEvent.click(within(call).getByRole('button', { name: 'Apply' }));
    expect(given.onApply).toHaveBeenCalledWith('Inbox/Call Mara.md');
    const junk = within(region).getByRole('listitem', { name: 'Junk' });
    expect(within(junk).queryByRole('button')).toBeNull();
    expect(within(junk).getByText('Make it a task under Larkspur Payroll')).toBeTruthy();
  });

  it('shows what was done, with Undo, and why an undo was refused', async () => {
    const applied = row('Call Mara', {
      kind: 'applied',
      words: 'Made it a task.',
      problem: 'Not undone: it was changed since.',
    });
    const { given, region } = show(plan([applied], { canApplyAll: false, canUndoAll: true }));
    const call = within(region).getByRole('listitem', { name: 'Call Mara' });
    expect(within(call).getByText('Made it a task.')).toBeTruthy();
    expect(within(call).getByText('Not undone: it was changed since.')).toBeTruthy();
    await userEvent.click(within(call).getByRole('button', { name: 'Undo' }));
    expect(given.onUndo).toHaveBeenCalledWith('Inbox/Call Mara.md');
  });

  it('shows why a row asked instead, and why one failed beside Apply again', () => {
    const { region } = show(
      plan([
        row('Asked', { kind: 'asked', words: 'It changed since the preview.' }),
        row('Failed', {
          kind: 'apply',
          said: 'Not applied: the disk is full. Nothing was left changed.',
        }),
      ]),
    );
    const asked = within(region).getByRole('listitem', { name: 'Asked' });
    expect(within(asked).getByText('It changed since the preview.')).toBeTruthy();
    expect(within(asked).queryByRole('button')).toBeNull();
    const failed = within(region).getByRole('listitem', { name: 'Failed' });
    expect(within(failed).getByText(/the disk is full/u)).toBeTruthy();
    expect(within(failed).getByRole('button', { name: 'Apply' })).toBeTruthy();
  });

  it('offers Apply all sure ones and Undo all, and holds them while rows are written', async () => {
    const view = plan([row('Call Mara', { kind: 'apply', said: null })], { canUndoAll: true });
    const { given, region, rerender } = show(view);
    await userEvent.click(within(region).getByRole('button', { name: 'Apply all sure ones' }));
    await userEvent.click(within(region).getByRole('button', { name: 'Undo all' }));
    expect(given.onApplyAll).toHaveBeenCalledTimes(1);
    expect(given.onUndoAll).toHaveBeenCalledTimes(1);
    rerender(
      <AssistSummary
        view={{ ...view, busy: true } as AssistView}
        onDismiss={() => undefined}
        actions={given}
      />,
    );
    const all = within(region).getByRole('button', { name: 'Apply all sure ones' });
    expect(all.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(all);
    expect(given.onApplyAll).toHaveBeenCalledTimes(1);
  });

  it('offers neither bar button when nothing can be applied or undone', () => {
    const { region } = show(plan([row('Junk', { kind: 'none' }, 'ask')], { canApplyAll: false }));
    expect(within(region).queryByRole('button', { name: 'Apply all sure ones' })).toBeNull();
    expect(within(region).queryByRole('button', { name: 'Undo all' })).toBeNull();
    // Dismiss is there all the same: the assertion above is about the right container.
    expect(within(region).getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('says each result in a live region as it lands', () => {
    const { region } = show(plan([], { said: 'Call Mara: Made it a task.' }));
    const live = region.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('Call Mara: Made it a task.');
  });

  it('keeps the keyboard on the row it pressed: Apply gives way to its words, then to Undo', async () => {
    const given = actions();
    const at = (action: AssistRowAction) => (
      <AssistSummary
        view={plan([row('Call Mara', action)])}
        onDismiss={() => undefined}
        actions={given}
      />
    );
    const { rerender } = render(at({ kind: 'apply', said: null }));
    const apply = screen.getByRole('button', { name: 'Apply' });
    apply.focus();
    await userEvent.keyboard('{Enter}');
    expect(given.onApply).toHaveBeenCalledTimes(1);
    rerender(at({ kind: 'busy', words: 'Applying…' }));
    expect(document.activeElement?.textContent).toBe('Applying…');
    rerender(at({ kind: 'applied', words: 'Made it a task.', problem: null }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }));
  });

  it('leaves the focus where it is when another row changes', () => {
    const given = actions();
    const at = (action: AssistRowAction) => (
      <AssistSummary
        view={plan([row('Call Mara', action), row('Other', { kind: 'apply', said: null })])}
        onDismiss={() => undefined}
        actions={given}
      />
    );
    const { rerender } = render(at({ kind: 'apply', said: null }));
    const other = within(screen.getByRole('listitem', { name: 'Other' })).getByRole('button', {
      name: 'Apply',
    });
    other.focus();
    rerender(at({ kind: 'applied', words: 'Made it a task.', problem: null }));
    expect(document.activeElement).toBe(other);
  });
});
