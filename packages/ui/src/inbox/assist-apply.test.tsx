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

function actions() {
  return {
    onApply: vi.fn<(path: string) => void>(),
    onUndo: vi.fn<(path: string) => void>(),
    onApplyAll: vi.fn<() => void>(),
    onUndoAll: vi.fn<() => void>(),
  } satisfies AssistActions;
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

  it('follows the row even when the page took the focus back to its home meanwhile', () => {
    const given = actions();
    const at = (action: AssistRowAction) => (
      <div data-keys-home="" tabIndex={-1}>
        <AssistSummary
          view={plan([row('Call Mara', action)])}
          onDismiss={() => undefined}
          actions={given}
        />
      </div>
    );
    const { rerender, container } = render(at({ kind: 'apply', said: null }));
    screen.getByRole('button', { name: 'Apply' }).focus();
    rerender(at({ kind: 'busy', words: 'Applying…' }));
    // The page's home takes the focus as the row's words go, as the Inbox's does.
    (container.querySelector('[data-keys-home]') as HTMLElement).focus();
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

  it('says what Claude chose beside Apply, and only while it can be applied', () => {
    const caution =
      'Claude chose Larkspur Payroll; nothing in the item confirms it. Check it before you apply.';
    const offered = { ...row('Call Mara', { kind: 'apply', said: null }), caution };
    const done = {
      ...row('Done', { kind: 'applied', words: 'Filed it.', problem: null }),
      caution,
    };
    const { region } = show(plan([offered, done]));
    expect(
      within(within(region).getByRole('listitem', { name: 'Call Mara' })).getByText(caution),
    ).toBeTruthy();
    expect(
      within(within(region).getByRole('listitem', { name: 'Done' })).queryByText(caution),
    ).toBeNull();
  });

  it('shows rows an earlier apply left unfinished, line by line, with nothing to press', () => {
    const unfinished = [
      {
        row: '2026-11-17T12:00:00 Inbox/Lunch with Tobias.md 1.1',
        title: 'Lunch with Tobias',
        lines: [
          'It was to do: Made it a task. Added Tobias Fenn.',
          'Tobias Fenn was made (People/Tobias Fenn.md), as made. Link it from Lunch with Tobias, or put it in the Trash.',
        ],
      },
    ];
    render(
      <AssistSummary
        view={plan([])}
        onDismiss={() => undefined}
        actions={actions()}
        unfinished={unfinished}
      />,
    );
    const left = screen.getByRole('listitem', { name: 'Lunch with Tobias, left unfinished' });
    for (const line of unfinished[0]!.lines) expect(within(left).getByText(line)).toBeTruthy();
    // Nothing repairs it: with no way to put it aside given, there is nothing to press.
    expect(within(left).queryByRole('button')).toBeNull();
    expect(screen.getByText('Left unfinished')).toBeTruthy();
  });

  it('puts an unfinished row aside, by its row, once the person has put it right', async () => {
    const onPutAside = vi.fn<(row: string) => void>();
    const row = '2026-11-17T12:00:00 Inbox/Lunch with Tobias.md 1.1';
    render(
      <AssistSummary
        view={plan([])}
        onDismiss={() => undefined}
        unfinished={[
          { row, title: 'Lunch with Tobias', lines: ['It was to do: Added Tobias Fenn.'] },
        ]}
        onPutAside={onPutAside}
      />,
    );
    const left = screen.getByRole('listitem', { name: 'Lunch with Tobias, left unfinished' });
    // Named for its row, and saying what it does and does not do (round 4, 7).
    await userEvent.click(
      within(left).getByRole('button', { name: 'Put aside Lunch with Tobias' }),
    );
    expect(onPutAside).toHaveBeenCalledWith(row);
    expect(
      screen.getByText('Put aside changes no note: it only stops showing that row here.'),
    ).toBeTruthy();
  });

  it('says, in a live region there before it, that rows were left unfinished', () => {
    const view = plan([]);
    const { rerender } = render(<AssistSummary view={view} onDismiss={() => undefined} />);
    const live = screen.getByRole('status', { name: 'Left unfinished' });
    expect(live.textContent).toBe('');
    rerender(
      <AssistSummary
        view={view}
        onDismiss={() => undefined}
        unfinished={[
          { row: 'r', title: 'Lunch with Tobias', lines: ['It was to do: Added Tobias Fenn.'] },
        ]}
      />,
    );
    // The same region, so it is announced as it changes.
    expect(screen.getByRole('status', { name: 'Left unfinished' })).toBe(live);
    expect(live.textContent).toBe('1 row left unfinished by an earlier apply or undo.');
  });
});

describe('a row that would move the note, shown without Apply (#925)', () => {
  it('says why, offers nothing to press, and is said with no other row appliable', () => {
    const view = plan(
      [row('Call Mara', { kind: 'preview', words: 'Filing is not applied automatically yet.' })],
      {
        canApplyAll: false,
      },
    );
    render(<AssistSummary view={view} onDismiss={() => undefined} actions={null} />);
    const shown = screen.getByRole('listitem', { name: 'Call Mara' });
    expect(within(shown).getByText('Filing is not applied automatically yet.')).toBeTruthy();
    expect(within(shown).queryByRole('button')).toBeNull();
  });
});
