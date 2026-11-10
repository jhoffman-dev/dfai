// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createToasts } from './toasts.ts';
import { ToastHost } from './toast-host.tsx';

/** #815, attacked: what a toast's details popup does not hold to. Each `it.fails` is a bug. */

// Built from local parts, so the test reads the same in any timezone.
const SHOWN = new Date(2026, 8, 28, 9, 30).getTime();
const CLOCK = { now: () => SHOWN, today: () => '2026-09-28' };
const NOT_MOVED = 'Could not move “Sow the beans”.';

function host(clipboard?: { write: (text: string) => Promise<void> }) {
  const toasts = createToasts(CLOCK);
  render(
    <ToastHost
      toasts={toasts}
      activity={{ record: vi.fn() }}
      clock={CLOCK}
      {...(clipboard !== undefined && { clipboard })}
    />,
  );
  return toasts;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ToastHost — details under attack', () => {
  it.fails('keeps the details open when newer toasts push their toast out of the queue', () => {
    const toasts = host({ write: () => Promise.resolve() });
    act(() => void toasts.show({ message: NOT_MOVED, tone: 'error' }));
    fireEvent.click(screen.getByRole('button', { name: NOT_MOVED }));
    expect(screen.getByRole('dialog', { name: 'Error details' })).toBeTruthy();

    act(() => {
      toasts.show({ message: 'Task added', tone: 'change' });
      toasts.show({ message: 'Note moved', tone: 'change' });
      toasts.show({ message: 'Note renamed', tone: 'change' });
    });

    // The person is still reading it: nothing they did closed it.
    expect(screen.queryByRole('dialog', { name: 'Error details' })).not.toBeNull();
  });

  it.fails('keeps the details open when a newer toast takes the same slot', () => {
    const toasts = host({ write: () => Promise.resolve() });
    act(() => void toasts.show({ message: NOT_MOVED, tone: 'error', slot: 'move' }));
    fireEvent.click(screen.getByRole('button', { name: NOT_MOVED }));

    act(() => void toasts.show({ message: 'Note moved', tone: 'change', slot: 'move' }));

    expect(screen.queryByRole('dialog', { name: 'Error details' })).not.toBeNull();
  });

  it.fails('shows the whole of a long toast, not less than the toast itself says', () => {
    const toasts = host({ write: () => Promise.resolve() });
    const long = `Could not import “Orchard walk”: ${'the feed answered with a page of prose. '.repeat(12)}End of it.`;
    expect(long.length).toBeGreaterThan(300);
    act(() => void toasts.show({ message: long, tone: 'error' }));
    fireEvent.click(screen.getByRole('button', { name: long }));

    const popup = screen.getByRole('dialog', { name: 'Error details' });
    expect(popup.querySelector('.event-details__message')?.textContent).toBe(long);
  });

  it.fails('says “Could not copy.” where the webview has no clipboard at all', () => {
    // Plain http (the iPad web build on a LAN address) has no `navigator.clipboard`.
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const thrown: unknown[] = [];
    const swallow = (event: ErrorEvent) => {
      thrown.push(event.error);
      event.preventDefault();
    };
    window.addEventListener('error', swallow);
    try {
      const toasts = host();
      act(() => void toasts.show({ message: NOT_MOVED, tone: 'error' }));
      fireEvent.click(screen.getByRole('button', { name: NOT_MOVED }));
      const popup = screen.getByRole('dialog', { name: 'Error details' });
      fireEvent.click(within(popup).getByRole('button', { name: 'Copy' }));
      expect(within(popup).queryByText('Could not copy.')).not.toBeNull();
    } finally {
      window.removeEventListener('error', swallow);
    }
  });

  it.fails(
    'lets a warning go by itself once its details were closed from the keyboard',
    async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const toasts = host({ write: () => Promise.resolve() });
      act(() => void toasts.show({ message: 'The undo was refused.', tone: 'warning' }));

      await user.tab();
      await user.keyboard('{Enter}');
      expect(screen.getByRole('dialog', { name: 'Warning details' })).toBeTruthy();
      await user.keyboard('{Escape}');
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(screen.queryByRole('dialog')).toBeNull();

      // Read and closed: the toast has its full time again, and then goes.
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(screen.queryByText('The undo was refused.')).toBeNull();
    },
  );

  it.fails('dates a toast that stayed past midnight as yesterday’s', () => {
    let today = '2026-09-28';
    const clock = { now: () => SHOWN, today: () => today };
    const toasts = createToasts(clock);
    const drawn = () => (
      <ToastHost
        toasts={toasts}
        activity={{ record: vi.fn() }}
        clock={clock}
        clipboard={{ write: () => Promise.resolve() }}
      />
    );
    const { rerender } = render(drawn());
    act(() => void toasts.show({ message: NOT_MOVED, tone: 'error' }));
    today = '2026-09-29';
    rerender(drawn());
    fireEvent.click(screen.getByRole('button', { name: NOT_MOVED }));
    expect(within(screen.getByRole('dialog')).getByText('Yesterday, 09:30')).toBeTruthy();
  });
});
