// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createToasts } from './toasts.ts';
import { ToastHost } from './toast-host.tsx';

/** #815, attacked: what a toast's details popup does not hold to. Each was a bug, and is held to here. */

// Built from local parts, so the test reads the same in any timezone.
const SHOWN = new Date(2026, 8, 28, 9, 30).getTime();
const CLOCK = { now: () => SHOWN, today: () => '2026-09-28' };
const NOT_MOVED = 'Could not move “Sow the beans”.';
const REFUSED = 'The undo was refused.';

const column = () => screen.getByRole('region', { name: 'Notifications', hidden: true });
const gone = (role: string, name?: string) =>
  waitFor(() =>
    expect(screen.queryByRole(role, name === undefined ? {} : { name })).toBeNull(),
  );

/** A dialog as the peek is one, with its place for the window's toasts. */
function peekDrawn() {
  render(
    <div role="dialog" aria-label="Plan the harvest" tabIndex={-1}>
      <div data-testid="toast-place" />
    </div>,
  );
  return {
    peek: screen.getByRole('dialog', { name: 'Plan the harvest' }),
    place: screen.getByTestId('toast-place'),
  };
}

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
  it('keeps the details open when newer toasts push their toast out of the queue', () => {
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

  it('keeps the details open when a newer toast takes the same slot', () => {
    const toasts = host({ write: () => Promise.resolve() });
    act(() => void toasts.show({ message: NOT_MOVED, tone: 'error', slot: 'move' }));
    fireEvent.click(screen.getByRole('button', { name: NOT_MOVED }));

    act(() => void toasts.show({ message: 'Note moved', tone: 'change', slot: 'move' }));

    expect(screen.queryByRole('dialog', { name: 'Error details' })).not.toBeNull();
  });

  it('keeps the details open when another vault opens and every toast goes', () => {
    const toasts = createToasts(CLOCK);
    const drawn = (vault: string) => (
      <ToastHost
        toasts={toasts}
        activity={{ record: vi.fn() }}
        vault={vault}
        clock={CLOCK}
        clipboard={{ write: () => Promise.resolve() }}
      />
    );
    const { rerender } = render(drawn('/vaults/orchard'));
    act(() => void toasts.show({ message: NOT_MOVED, tone: 'error' }));
    fireEvent.click(screen.getByRole('button', { name: NOT_MOVED }));

    rerender(drawn('/vaults/greenhouse'));

    expect(screen.queryByRole('button', { name: NOT_MOVED })).toBeNull();
    const popup = screen.getByRole('dialog', { name: 'Error details' });
    expect(within(popup).getByText(NOT_MOVED)).toBeTruthy();
  });

  it('shows the whole of a long toast, not less than the toast itself says', () => {
    const toasts = host({ write: () => Promise.resolve() });
    const long = `Could not import “Orchard walk”: ${'the feed answered with a page of prose. '.repeat(12)}End of it.`;
    expect(long.length).toBeGreaterThan(300);
    act(() => void toasts.show({ message: long, tone: 'error' }));
    fireEvent.click(screen.getByRole('button', { name: long }));

    const popup = screen.getByRole('dialog', { name: 'Error details' });
    expect(popup.querySelector('.event-details__message')?.textContent).toBe(long);
  });

  it('says “Could not copy.” where the webview has no clipboard at all', async () => {
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
      // Said once the write has refused: a moment after the press, as any refusal is.
      expect(await within(popup).findByText('Could not copy.')).toBeTruthy();
      expect(thrown).toEqual([]);
    } finally {
      window.removeEventListener('error', swallow);
    }
  });

  it('holds a warning whose details were closed from the keyboard, then lets it go once the focus leaves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<button type="button">Elsewhere</button>);
    const toasts = host({ write: () => Promise.resolve() });
    act(() => void toasts.show({ message: REFUSED, tone: 'warning' }));
    const words = () => screen.getByRole('button', { name: REFUSED });

    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(words());
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Warning details' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await gone('dialog');
    await waitFor(() => expect(document.activeElement).toBe(words()));

    // The focus is on its words, and the person's own: it never goes from under it.
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(document.activeElement).toBe(words());

    // Read and left: it has its full time again, and then goes.
    await user.tab({ shift: true });
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    expect(document.activeElement).toBe(elsewhere);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.queryByText(REFUSED)).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('hands the focus to the toasts’ column when a warning times out with the focus put back on it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const toasts = host({ write: () => Promise.resolve() });
    act(() => void toasts.show({ message: REFUSED, tone: 'warning' }));

    await user.click(screen.getByRole('button', { name: REFUSED }));
    // Off it again, so nothing but the focus could hold it.
    await user.unhover(screen.getByRole('button', { name: REFUSED, hidden: true }));
    await user.keyboard('{Escape}');
    await gone('dialog');
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(screen.queryByText(REFUSED)).toBeNull();
    expect(document.activeElement).toBe(column());
  });

  it('hands the focus to the toasts’ column when the details close with their toast gone', async () => {
    const toasts = host({ write: () => Promise.resolve() });
    let shown = 0;
    act(() => void (shown = toasts.show({ message: NOT_MOVED, tone: 'error' })));
    await userEvent.click(screen.getByRole('button', { name: NOT_MOVED }));

    act(() => toasts.dismiss(shown));
    expect(screen.queryByRole('button', { name: NOT_MOVED, hidden: true })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await gone('dialog');

    await waitFor(() => expect(document.activeElement).toBe(column()));
  });

  it('hands the focus to the peek, inside its trap, when the details close with their toast gone', async () => {
    const { peek, place } = peekDrawn();
    const toasts = host({ write: () => Promise.resolve() });
    act(() => toasts.placeIn(place));
    let shown = 0;
    act(() => void (shown = toasts.show({ message: NOT_MOVED, tone: 'error' })));
    await userEvent.click(within(place).getByRole('button', { name: NOT_MOVED }));

    act(() => toasts.dismiss(shown));
    await userEvent.keyboard('{Escape}');
    await gone('dialog', 'Error details');

    await waitFor(() => expect(document.activeElement).toBe(peek));
  });

  it('keeps the details open, and their toast known and held, as the peek comes up under them', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { place } = peekDrawn();
    const toasts = host({ write: () => Promise.resolve() });
    act(() => void toasts.show({ message: REFUSED, tone: 'warning' }));
    const pressed = screen.getByRole('button', { name: REFUSED });
    await user.click(pressed);

    // The toasts are drawn anew in the peek's place: other elements, the same toasts.
    act(() => toasts.placeIn(place));

    expect(screen.getByRole('dialog', { name: 'Warning details' })).toBeTruthy();
    const redrawn = within(place).getByRole('button', { name: REFUSED, hidden: true });
    expect(redrawn).not.toBe(pressed);
    expect(redrawn.getAttribute('aria-expanded')).toBe('true');
    // Still being read: a warning's five seconds do not run under its open details.
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(within(place).queryByText(REFUSED)).not.toBeNull();

    await user.keyboard('{Escape}');
    await gone('dialog', 'Warning details');
    await waitFor(() => expect(document.activeElement).toBe(redrawn));
  });

  it('dates a toast that stayed past midnight as yesterday’s, though nothing drew it again', () => {
    let today = '2026-09-28';
    const clock = { now: () => SHOWN, today: () => today };
    const toasts = createToasts(clock);
    render(
      <ToastHost
        toasts={toasts}
        activity={{ record: vi.fn() }}
        clock={clock}
        clipboard={{ write: () => Promise.resolve() }}
      />,
    );
    act(() => void toasts.show({ message: NOT_MOVED, tone: 'error' }));
    // Midnight passes with the toast up; the queue has not changed, so nothing redraws.
    today = '2026-09-29';
    fireEvent.click(screen.getByRole('button', { name: NOT_MOVED }));
    expect(within(screen.getByRole('dialog')).getByText('Yesterday, 09:30')).toBeTruthy();
  });
});
