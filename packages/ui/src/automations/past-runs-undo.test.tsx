// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PastRunsUndo } from './past-runs-undo.tsx';

const SWEEP = {
  id: '.atlas/automations/Sweep.md',
  name: 'Sweep',
  lastRun: '18 Nov 09:00 · Moved 2 notes',
};

describe('PastRunsUndo (#901)', () => {
  it('offers each rule’s last run to undo, saying when it was and what it did', async () => {
    const onUndo = vi.fn();
    render(<PastRunsUndo runs={[SWEEP]} busy={false} onUndo={onUndo} />);
    expect(screen.getByText('18 Nov 09:00 · Moved 2 notes')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Undo last run of Sweep' }));
    expect(onUndo).toHaveBeenCalledWith(SWEEP.id);
  });

  it('holds the buttons while a run or an undo is under way', async () => {
    const onUndo = vi.fn();
    render(<PastRunsUndo runs={[SWEEP]} busy onUndo={onUndo} />);
    const button = screen.getByRole('button', { name: 'Undo last run of Sweep' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(button);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('draws nothing when no run can be undone', () => {
    const { container } = render(<PastRunsUndo runs={[]} busy={false} onUndo={() => {}} />);
    expect(container.textContent).toBe('');
  });
});
