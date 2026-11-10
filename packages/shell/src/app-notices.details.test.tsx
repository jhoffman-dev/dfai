// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath } from '@dfai/domain';
import { AppNotices } from './app-notices.tsx';

/** #815: a notice above the window opens to its details. */

// Built from local parts, so the test reads the same in any timezone.
const SHOWN = new Date(2026, 8, 28, 9, 30).getTime();
const LATER = new Date(2026, 8, 28, 11, 45).getTime();

const NOTHING_KEPT: ComponentProps<typeof AppNotices>['stranded'] = {
  notice: null,
  waiting: [],
  forget: vi.fn(),
};
const DISK_FULL = 'Could not create the note: the disk is full';

function notices(clock: { now: () => number; today: () => string }, write = vi.fn()) {
  const drawn = (messages: readonly (string | null)[], kept = NOTHING_KEPT) => (
    <AppNotices
      messages={messages}
      links={null}
      stranded={kept}
      clock={clock}
      clipboard={{ write }}
    />
  );
  return { drawn, write };
}

const clockAt = (times: number[]) => ({
  now: () => times[0] ?? LATER,
  today: () => '2026-09-28',
  later: () => void times.shift(),
});

describe('AppNotices — a notice opens to its details', () => {
  it('opens a message as an error, dated when it was first shown', async () => {
    const clock = clockAt([SHOWN, LATER]);
    const { drawn } = notices(clock);
    const { rerender } = render(drawn([DISK_FULL]));
    // Drawn again later, as the window is: the notice keeps the time it appeared.
    clock.later();
    rerender(drawn([DISK_FULL]));

    const words = screen.getByRole('button', { name: DISK_FULL });
    expect(screen.getByRole('alert').contains(words)).toBe(true);
    await userEvent.click(words);
    const popup = screen.getByRole('dialog', { name: 'Error details' });
    expect(within(popup).getByText('Today, 09:30')).toBeTruthy();
    expect(within(popup).getByText(DISK_FULL)).toBeTruthy();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('dates a notice again when it goes and comes back', async () => {
    const clock = clockAt([SHOWN, LATER]);
    const { drawn } = notices(clock);
    const { rerender } = render(drawn([DISK_FULL]));
    rerender(drawn([null]));
    clock.later();
    rerender(drawn([DISK_FULL]));

    await userEvent.click(screen.getByRole('button', { name: DISK_FULL }));
    expect(within(screen.getByRole('dialog')).getByText('Today, 11:45')).toBeTruthy();
  });

  it('keeps a notice its own button when the one above it clears, and two alike apart', () => {
    const { drawn } = notices(clockAt([SHOWN]));
    const { rerender } = render(drawn([DISK_FULL, 'Could not reach the calendar feed']));
    const feed = screen.getByRole('button', { name: 'Could not reach the calendar feed' });
    feed.focus();

    const NO_FEED = 'Could not reach the calendar feed';
    rerender(drawn([null, NO_FEED, NO_FEED]));

    const [first, second] = screen.getAllByRole('button', {
      name: 'Could not reach the calendar feed',
    });
    expect(first).toBe(feed);
    expect(document.activeElement).toBe(feed);
    expect(second).not.toBe(feed);
  });

  it('opens from the keyboard, and copies its text', async () => {
    const { drawn, write } = notices(clockAt([SHOWN]));
    write.mockResolvedValue(undefined);
    render(drawn([DISK_FULL]));
    screen.getByRole('button', { name: DISK_FULL }).focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(write).toHaveBeenCalledWith(`Error · Today, 09:30 (2026-09-28T09:30:00)\n${DISK_FULL}`);
  });

  it('opens the word of kept work as a warning, beside its buttons', async () => {
    const { drawn } = notices(clockAt([SHOWN]));
    const plan = createVaultPath('Garden plan.md');
    const kept = { notice: 'Changes to 1 note are kept.', waiting: [plan], forget: vi.fn() };
    render(drawn([], kept));

    expect(
      screen.getByRole('button', { name: 'Discard kept changes to Garden plan' }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Changes to 1 note are kept.' }));
    expect(screen.getByRole('dialog', { name: 'Warning details' })).toBeTruthy();
  });
});
