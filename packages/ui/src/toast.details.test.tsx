// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { EventDetailsView } from './details/index.ts';
import { ToastStack } from './toast-stack.tsx';
import { Toast } from './toast.tsx';

/** #815: a warning or an error toast opens, from its words, to its details. */

afterEach(() => {
  vi.useRealTimers();
});

const NOT_SAVED: EventDetailsView = {
  level: 'warning',
  time: 'Today, 09:30',
  dateTime: '2026-09-28T09:30:00',
  message: 'The undo was refused: Garden plan changed since.',
  subject: null,
  details: [],
  text: 'Warning · Today, 09:30\nThe undo was refused: Garden plan changed since.',
};

const copies = () => vi.fn(() => Promise.resolve());

describe('Toast — its details', () => {
  it('opens from its words, which stay the live region', () => {
    render(
      <Toast
        message={NOT_SAVED.message}
        tone="warning"
        details={NOT_SAVED}
        onCopy={copies()}
        onDismiss={vi.fn()}
      />,
    );
    const words = screen.getByRole('button', { name: NOT_SAVED.message });
    expect(screen.getByRole('status').contains(words)).toBe(true);
    expect(words.tabIndex).toBe(0);

    fireEvent.click(words);
    expect(screen.getByRole('dialog', { name: 'Warning details' })).toBeTruthy();
  });

  it('stays while its details are read, then gives its full time again', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <Toast
        message={NOT_SAVED.message}
        tone="warning"
        details={NOT_SAVED}
        onCopy={copies()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: NOT_SAVED.message }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    act(() => vi.advanceTimersByTime(4999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('is words alone without details, as a change made is', () => {
    render(<Toast message="Task added" tone="change" onDismiss={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Task added' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Task added');
  });
});

describe('ToastStack — its details', () => {
  it('opens the toast that has them, and copies through the stack', () => {
    const onCopy = copies();
    render(
      <ToastStack
        toasts={[
          { id: 1, message: 'Task added', tone: 'change' },
          { id: 2, message: NOT_SAVED.message, tone: 'warning', details: NOT_SAVED },
        ]}
        onDismiss={vi.fn()}
        onCopy={onCopy}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Task added' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: NOT_SAVED.message }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenCalledWith(NOT_SAVED.text);
  });
});
