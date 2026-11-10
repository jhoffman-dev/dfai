// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AppNotices } from './app-notices.tsx';

/** #815, attacked: a notice's details while the notices change. Each `it.fails` is a bug. */

const SHOWN = new Date(2026, 8, 28, 9, 30).getTime();
const CLOCK = { now: () => SHOWN, today: () => '2026-09-28' };
const NOTHING_KEPT = { notice: null, waiting: [], forget: vi.fn() };
const DISK_FULL = 'Could not create the note: the disk is full';
const NO_FEED = 'Could not reach the calendar feed';

const drawn = (messages: readonly (string | null)[]) => (
  <AppNotices
    messages={messages}
    links={null}
    stranded={NOTHING_KEPT}
    clock={CLOCK}
    clipboard={{ write: () => Promise.resolve() }}
  />
);

describe('AppNotices — details while the notices change', () => {
  it.fails('keeps the details open when the notice it came from clears itself', () => {
    const { rerender } = render(drawn([DISK_FULL]));
    fireEvent.click(screen.getByRole('button', { name: DISK_FULL }));
    expect(screen.getByRole('dialog', { name: 'Error details' })).toBeTruthy();

    rerender(drawn([null]));

    expect(screen.queryByRole('dialog', { name: 'Error details' })).not.toBeNull();
  });

  it.fails('never swaps the open details for another notice’s', () => {
    const { rerender } = render(drawn([DISK_FULL]));
    fireEvent.click(screen.getByRole('button', { name: DISK_FULL }));

    // Another message takes the same place in the list.
    rerender(drawn([NO_FEED]));

    const popup = screen.queryByRole('dialog');
    expect(popup === null || within(popup).queryByText(NO_FEED) === null).toBe(true);
  });
});
