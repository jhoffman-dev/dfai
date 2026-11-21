// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PastRunsUndo, type UndoableRun } from './past-runs-undo.tsx';

const SWEEP: UndoableRun = {
  id: '.atlas/automations/Sweep.md',
  name: 'Sweep',
  lastRun: '18 Nov 09:00 · Moved 2 notes',
};
const TIDY: UndoableRun = {
  id: '.atlas/automations/Tidy.md',
  name: 'Tidy',
  lastRun: '18 Nov 10:00 · Archived 1 note',
};

function draw(props: Partial<Parameters<typeof PastRunsUndo>[0]> = {}) {
  const onUndo = vi.fn();
  const all = { runs: [SWEEP], busy: false, said: null, onUndo, ...props };
  const view = render(<PastRunsUndo {...all} />);
  const redraw = (next: Partial<Parameters<typeof PastRunsUndo>[0]>) =>
    view.rerender(<PastRunsUndo {...all} {...next} />);
  return { onUndo, redraw };
}

const undoOf = (name: string) => screen.getByRole('button', { name: `Undo last run of ${name}` });

describe('PastRunsUndo (#901)', () => {
  it('offers each rule’s last run to undo, saying when it was and what it did', async () => {
    const { onUndo } = draw();
    expect(screen.getByText('18 Nov 09:00 · Moved 2 notes')).toBeTruthy();
    await userEvent.click(undoOf('Sweep'));
    expect(onUndo).toHaveBeenCalledWith(SWEEP.id);
  });

  it('holds the buttons while a run or an undo is under way, keeping focus where it is', async () => {
    const { onUndo } = draw({ busy: true });
    const button = undoOf('Sweep');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.focus();
    await userEvent.click(button);
    expect(onUndo).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });

  it('draws nothing when no run can be undone and nothing has been said', () => {
    render(<PastRunsUndo runs={[]} busy={false} said={null} onUndo={() => {}} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says why an undo was refused, and keeps the button focused for another try (#920)', async () => {
    const { redraw } = draw();
    await userEvent.click(undoOf('Sweep'));
    redraw({ busy: true });
    redraw({
      busy: false,
      said: 'It is no longer where the run put it, so it was left where it is.',
    });
    expect(screen.getByRole('status').textContent).toContain(
      'It is no longer where the run put it',
    );
    expect(document.activeElement).toBe(undoOf('Sweep'));
  });

  it('announces an undo that worked, and moves focus to the next rule’s button (#920)', async () => {
    const { redraw } = draw({ runs: [SWEEP, TIDY] });
    await userEvent.click(undoOf('Sweep'));
    redraw({ runs: [TIDY], said: 'Undid the last run of Sweep. Put back 2 notes.' });
    expect(screen.getByRole('status').textContent).toBe(
      'Undid the last run of Sweep. Put back 2 notes.',
    );
    expect(document.activeElement).toBe(undoOf('Tidy'));
  });

  it('moves focus to what was said once the last run is undone, never to the page (#920)', async () => {
    const { redraw } = draw();
    await userEvent.click(undoOf('Sweep'));
    redraw({ runs: [], said: 'Undid the last run of Sweep. Put back 2 notes.' });
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Undid the last run of Sweep. Put back 2 notes.');
    expect(document.activeElement).not.toBe(document.body);
    expect(status.contains(document.activeElement)).toBe(true);
  });
});
