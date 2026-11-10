// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EventDetailsView } from './details/index.ts';
import { ToastStack, type ToastShown } from './toast-stack.tsx';
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

/** A queue of one warning that lets it go when told, with somewhere else for the focus to be. */
function Queue({ onGone }: { onGone?: () => void }) {
  const [toasts, setToasts] = useState<ToastShown[]>([
    { id: 7, message: NOT_SAVED.message, tone: 'warning', details: NOT_SAVED },
  ]);
  return (
    <>
      <button type="button">Elsewhere</button>
      <ToastStack
        toasts={toasts}
        onDismiss={() => {
          setToasts([]);
          onGone?.();
        }}
        onCopy={copies()}
      />
    </>
  );
}

function typing() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}
const words = () => screen.getByRole('button', { name: NOT_SAVED.message });
const column = () => screen.getByRole('group', { name: 'Notifications' });
const closed = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

describe('Toast — the focus once its details close', () => {
  it('goes on holding a toast whose details were opened and closed from the keyboard', async () => {
    const user = typing();
    const onGone = vi.fn();
    render(<Queue onGone={onGone} />);
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(words());

    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Warning details' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await closed();
    await waitFor(() => expect(document.activeElement).toBe(words()));

    // The focus was the person's before the details opened, and is again: the toast waits.
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(onGone).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(words());
  });

  it('hands the focus to its column when it times out with the focus put back on it', async () => {
    const user = typing();
    const onGone = vi.fn();
    render(<Queue onGone={onGone} />);
    const pressed = words();
    await user.click(pressed);
    // Off it again, so nothing but the focus could hold it.
    await user.unhover(pressed);
    await user.keyboard('{Escape}');
    await closed();
    await waitFor(() => expect(document.activeElement).toBe(words()));

    // Opened by a pointer from outside it: the focus was put there, and holds nothing.
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(NOT_SAVED.message)).toBeNull();
    expect(document.activeElement).toBe(column());
  });

  it('holds a toast clicked open by someone whose focus was already in it', async () => {
    const user = typing();
    const onGone = vi.fn();
    render(<Queue onGone={onGone} />);
    await user.tab();
    await user.tab();
    const pressed = words();
    await user.click(pressed);
    // Off it again, so nothing but the focus could hold it.
    await user.unhover(pressed);
    await user.keyboard('{Escape}');
    await closed();

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(onGone).not.toHaveBeenCalled();
  });

  it('holds again once the person Tabs away from the words and back', async () => {
    const user = typing();
    const onGone = vi.fn();
    render(<Queue onGone={onGone} />);
    const pressed = words();
    await user.click(pressed);
    // Off it again, so nothing but the focus could hold it.
    await user.unhover(pressed);
    await user.keyboard('{Escape}');
    await closed();
    await waitFor(() => expect(document.activeElement).toBe(words()));

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Elsewhere' }));
    await user.tab();
    expect(document.activeElement).toBe(words());

    // This focus is the person's own.
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(onGone).not.toHaveBeenCalled();
  });

  it('hands the focus to its column when it is sent away from the keyboard', async () => {
    const user = typing();
    render(<Queue />);
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    dismiss.focus();
    await user.keyboard('{Enter}');

    expect(screen.queryByText(NOT_SAVED.message)).toBeNull();
    expect(document.activeElement).toBe(column());
  });

  it('leaves the focus where it is when it goes without it', async () => {
    typing();
    render(<Queue />);
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(screen.queryByText(NOT_SAVED.message)).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });
});
