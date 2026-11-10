// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ToastStack, type ToastShown } from './toast-stack.tsx';

/** #320: several toasts at once, each with its own time and its own Undo. */
afterEach(() => {
  vi.useRealTimers();
});

const moved = (id: number, title: string, onUndo = vi.fn()): ToastShown => ({
  id,
  message: `Moved “${title}” to Done`,
  tone: 'change',
  onUndo,
});

describe('ToastStack', () => {
  it('draws its column, empty, while there is nothing to say: where a lost focus is sent', () => {
    render(<ToastStack toasts={[]} onDismiss={vi.fn()} />);
    const column = screen.getByRole('region', { name: 'Notifications' });
    expect(column.childElementCount).toBe(0);
    // Tab never stops on it, yet it can be handed the focus.
    expect(column.tabIndex).toBe(-1);
  });

  it('shows several, oldest first, each saying its own words', () => {
    render(
      <ToastStack
        toasts={[moved(1, 'Send the Larkspur invoice'), moved(2, 'Call Mara Quill')]}
        onDismiss={vi.fn()}
      />,
    );
    const said = screen.getAllByRole('status').map((each) => each.textContent);
    expect(said).toEqual([
      'Moved “Send the Larkspur invoice” to Done',
      'Moved “Call Mara Quill” to Done',
    ]);
  });

  it('undoes the change of the toast whose Undo was pressed, then lets that one go', () => {
    const first = vi.fn();
    const second = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ToastStack
        toasts={[moved(1, 'Send the Larkspur invoice', first), moved(2, 'Call Mara Quill', second)]}
        onDismiss={onDismiss}
      />,
    );
    const toasts = document.querySelectorAll<HTMLElement>('.toast');
    fireEvent.click(within(toasts[1]!).getByRole('button', { name: 'Undo' }));

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledWith(2);
  });

  it('lets each go after its own five seconds, and holds the one under the pointer', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(<ToastStack toasts={[moved(1, 'A')]} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(3000));
    rerender(<ToastStack toasts={[moved(1, 'A'), moved(2, 'B')]} onDismiss={onDismiss} />);
    fireEvent.pointerEnter(document.querySelectorAll('.toast')[1]!);

    act(() => vi.advanceTimersByTime(2000));
    expect(onDismiss.mock.calls).toEqual([[1]]);
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss.mock.calls).toEqual([[1]]);
  });

  it('marks a warning and an error by their dot, and keeps an error until it is sent away', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <ToastStack
        toasts={[
          { id: 1, message: 'Changed since, so not undone.', tone: 'warning' },
          { id: 2, message: 'The disk is full.', tone: 'error' },
        ]}
        onDismiss={onDismiss}
      />,
    );
    expect(document.querySelector('.toast__dot--warning')).not.toBeNull();
    expect(document.querySelector('.toast__dot--error')).not.toBeNull();

    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss.mock.calls).toEqual([[1]]);
  });

  it('never takes the focus, and its Undo is reached by Tab', () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    render(<ToastStack toasts={[moved(1, 'A')]} onDismiss={vi.fn()} />);

    expect(document.activeElement).toBe(before);
    const undo = screen.getByRole('button', { name: 'Undo' });
    expect(undo.tabIndex).toBe(0);
    before.remove();
  });
});
