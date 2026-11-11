// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createToasts } from './toasts.ts';
import { ToastHost } from './toast-host.tsx';

/** #815: a warning or an error toast opens to the details of the line Activity keeps of it. */

// Built from local parts, so the test reads the same in any timezone.
const SHOWN = new Date(2026, 8, 28, 9, 30).getTime();
const CLOCK = { now: () => SHOWN, today: () => '2026-09-28' };

function host() {
  const toasts = createToasts(CLOCK);
  const write = vi.fn(() => Promise.resolve());
  render(
    <ToastHost
      toasts={toasts}
      activity={{ record: vi.fn() }}
      clock={CLOCK}
      clipboard={{ write }}
    />,
  );
  return { toasts, write };
}

describe('ToastHost — a toast opens to its details', () => {
  it('opens an error toast to its level, when it was shown and its words', () => {
    const { toasts, write } = host();
    act(() => void toasts.show({ message: 'Could not move “Sow the beans”.', tone: 'error' }));
    fireEvent.click(screen.getByRole('button', { name: 'Could not move “Sow the beans”.' }));

    const popup = screen.getByRole('dialog', { name: 'Error details' });
    expect(within(popup).getByText('Today, 09:30')).toBeTruthy();
    expect(within(popup).getByText('Could not move “Sow the beans”.')).toBeTruthy();

    fireEvent.click(within(popup).getByRole('button', { name: 'Copy' }));
    expect(write).toHaveBeenCalledWith(
      'Error · Today, 09:30 (2026-09-28T09:30:00)\nCould not move “Sow the beans”.',
    );
  });

  it('opens a warning as a warning', () => {
    const { toasts } = host();
    act(() => void toasts.show({ message: 'The undo was refused.', tone: 'warning' }));
    fireEvent.click(screen.getByRole('button', { name: 'The undo was refused.' }));
    expect(screen.getByRole('dialog', { name: 'Warning details' })).toBeTruthy();
  });

  it('gives a change made nothing to open: the file is its record', () => {
    const { toasts } = host();
    act(() => void toasts.show({ message: 'Task added', tone: 'change' }));
    expect(screen.getByRole('status').textContent).toBe('Task added');
    expect(screen.queryByRole('button', { name: 'Task added' })).toBeNull();
  });
});
