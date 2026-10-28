// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath } from '@dfai/domain';
import { TrailBar, type TrailWalk } from './trail-bar.tsx';

const note = (path: string, title: string) => ({ path: createVaultPath(path), title });

function walk(overrides: Partial<TrailWalk> = {}): TrailWalk {
  return {
    steps: [note('Payroll.md', 'Payroll'), note('Budget.md', 'Budget'), note('Bees.md', 'Bees')],
    at: 1,
    linked: [note('Mara Quill.md', 'Mara Quill')],
    related: [note('Honey.md', 'Honey')],
    saved: null,
    problem: null,
    onBack: vi.fn(),
    onForward: vi.fn(),
    onStandOn: vi.fn(),
    onStep: vi.fn(),
    onSave: vi.fn(),
    onOpenSaved: vi.fn(),
    onEnd: vi.fn(),
    ...overrides,
  };
}

describe('the trail bar', () => {
  it('shows the steps walked as a path, marking the one stood on', () => {
    render(<TrailBar trail={walk()} />);
    const steps = within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('button');
    expect(steps.map((step) => step.textContent)).toEqual(['Payroll', 'Budget', 'Bees']);
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual([null, 'step', null]);
  });

  it('steps back, forward, and onto any step walked', async () => {
    const trail = walk();
    render(<TrailBar trail={trail} />);
    await userEvent.click(screen.getByRole('button', { name: 'Step back' }));
    await userEvent.click(screen.getByRole('button', { name: 'Step forward' }));
    await userEvent.click(screen.getByRole('button', { name: 'Payroll' }));
    expect(trail.onBack).toHaveBeenCalledOnce();
    expect(trail.onForward).toHaveBeenCalledOnce();
    expect(trail.onStandOn).toHaveBeenCalledWith(0);
  });

  it('cannot step back from the first step nor forward from the last', () => {
    const { unmount } = render(<TrailBar trail={walk({ at: 0 })} />);
    expect(screen.getByRole('button', { name: 'Step back' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Step forward' }).hasAttribute('disabled')).toBe(
      false,
    );
    unmount();
    render(<TrailBar trail={walk({ at: 2 })} />);
    expect(screen.getByRole('button', { name: 'Step back' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Step forward' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('offers the next steps by link and by meaning', async () => {
    const trail = walk();
    render(<TrailBar trail={trail} />);
    const byLink = screen.getByRole('group', { name: 'Next by linked' });
    const byMeaning = screen.getByRole('group', { name: 'Next by related' });
    await userEvent.click(within(byLink).getByRole('button', { name: 'Step to Mara Quill' }));
    await userEvent.click(within(byMeaning).getByRole('button', { name: 'Step to Honey' }));
    expect(trail.onStep).toHaveBeenNthCalledWith(1, createVaultPath('Mara Quill.md'));
    expect(trail.onStep).toHaveBeenNthCalledWith(2, createVaultPath('Honey.md'));
  });

  it('leaves out a group with nothing in it', () => {
    render(<TrailBar trail={walk({ related: [] })} />);
    expect(screen.getByRole('group', { name: 'Next by linked' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Next by related' })).toBeNull();
  });

  it('saves and ends the trail, then says where it was saved', async () => {
    const trail = walk();
    const { rerender } = render(<TrailBar trail={trail} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save trail' }));
    await userEvent.click(screen.getByRole('button', { name: 'End trail' }));
    expect(trail.onSave).toHaveBeenCalledOnce();
    expect(trail.onEnd).toHaveBeenCalledOnce();
    expect(screen.queryByRole('status')).toBeNull();

    rerender(
      <TrailBar trail={{ ...trail, saved: note('Trail from Payroll.md', 'Trail from Payroll') }} />,
    );
    expect(screen.getByRole('status').textContent).toBe('Saved as Trail from Payroll');
    await userEvent.click(screen.getByRole('button', { name: 'Trail from Payroll' }));
    expect(trail.onOpenSaved).toHaveBeenCalledOnce();
  });

  it('says why a save failed', () => {
    render(<TrailBar trail={walk({ problem: 'No free name for the trail' })} />);
    expect(screen.getByRole('alert').textContent).toBe('No free name for the trail');
  });
});
