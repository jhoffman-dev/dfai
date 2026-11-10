// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppNotices } from './app-notices.tsx';

/** #815, attacked: a notice's details while the notices change. Each was a bug, and is held to here. */

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
  it('keeps the details open when the notice it came from clears itself', () => {
    const { rerender } = render(drawn([DISK_FULL]));
    fireEvent.click(screen.getByRole('button', { name: DISK_FULL }));
    expect(screen.getByRole('dialog', { name: 'Error details' })).toBeTruthy();

    rerender(drawn([null]));

    expect(screen.queryByRole('dialog', { name: 'Error details' })).not.toBeNull();
  });

  it('never swaps the open details for another notice’s', () => {
    const { rerender } = render(drawn([DISK_FULL]));
    fireEvent.click(screen.getByRole('button', { name: DISK_FULL }));

    // Another message takes the same place in the list.
    rerender(drawn([NO_FEED]));

    const popup = screen.queryByRole('dialog');
    expect(popup === null || within(popup).queryByText(NO_FEED) === null).toBe(true);
  });

  it('hands the focus to the notices’ region when the details close with their notice gone', async () => {
    const { rerender } = render(drawn([DISK_FULL]));
    await userEvent.click(screen.getByRole('button', { name: DISK_FULL }));

    rerender(drawn([null]));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Notices' })),
    );
  });

  it('tells two notices saying the same words apart: one is open, and the focus goes back to it', async () => {
    render(drawn([DISK_FULL, DISK_FULL]));
    const [, second] = screen.getAllByRole('button', { name: DISK_FULL });
    if (second === undefined) throw new Error('two notices are drawn');
    await userEvent.click(second);

    const twins = screen.getAllByRole('button', { name: DISK_FULL, hidden: true });
    expect(twins.map((twin) => twin.getAttribute('aria-expanded'))).toEqual(['false', 'true']);

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(second));
  });
});
