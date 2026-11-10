// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EventDetailsButton, EventDetailsHost, type EventDetailsView } from './event-details.tsx';

/** #815: the popup is the host's, so it outlives the line that opened it. */

const details = (message: string): EventDetailsView => ({
  level: 'error',
  time: 'Today, 14:03',
  dateTime: '2026-09-28T14:03:00',
  message,
  subject: 'Greenhouse plan',
  details: [],
  text: `Error · Today, 14:03\n${message}`,
});
const NOT_SAVED = 'Could not save Greenhouse plan.';
const NOT_MOVED = 'Could not move Orchard walk.';

const line = (message: string, onOpenSubject = vi.fn()) => (
  <EventDetailsButton
    key={message}
    id={message}
    details={details(message)}
    onCopy={() => Promise.resolve()}
    onOpenSubject={onOpenSubject}
  >
    {message}
  </EventDetailsButton>
);
const popup = () => screen.getByRole('dialog', { name: 'Error details' });

describe('EventDetailsHost', () => {
  it('keeps the details open, on the words they opened with, when their line goes', async () => {
    const opens = vi.fn();
    const { rerender } = render(<EventDetailsHost>{line(NOT_SAVED, opens)}</EventDetailsHost>);
    await userEvent.click(screen.getByRole('button', { name: NOT_SAVED }));

    rerender(<EventDetailsHost>{line(NOT_MOVED)}</EventDetailsHost>);

    expect(screen.queryByRole('button', { name: NOT_SAVED })).toBeNull();
    expect(within(popup()).getByText(NOT_SAVED)).toBeTruthy();
    expect(within(popup()).queryByText(NOT_MOVED)).toBeNull();
    // What it could do, it still can: the link is the gone line's own.
    await userEvent.click(within(popup()).getByRole('button', { name: 'Open Greenhouse plan' }));
    expect(opens).toHaveBeenCalledTimes(1);
  });

  it('shows one line’s details at a time, and says which line is open', async () => {
    render(
      <EventDetailsHost>
        {line(NOT_SAVED)}
        {line(NOT_MOVED)}
      </EventDetailsHost>,
    );
    const saved = screen.getByRole('button', { name: NOT_SAVED });
    expect(saved.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(saved);

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(popup()).getByText(NOT_SAVED)).toBeTruthy();
    const expanded = (name: string) =>
      screen.getByRole('button', { name, hidden: true }).getAttribute('aria-expanded');
    expect(expanded(NOT_SAVED)).toBe('true');
    expect(expanded(NOT_MOVED)).toBe('false');
  });

  it('puts the focus back on the line where it is drawn now, not where it was pressed', async () => {
    const { rerender } = render(<EventDetailsHost>{line(NOT_SAVED)}</EventDetailsHost>);
    const pressed = screen.getByRole('button', { name: NOT_SAVED });
    await userEvent.click(pressed);

    // Gathered under something new: the same line, another element.
    rerender(
      <EventDetailsHost>
        <section>{line(NOT_SAVED)}</section>
      </EventDetailsHost>,
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const drawn = screen.getByRole('button', { name: NOT_SAVED });
    expect(drawn).not.toBe(pressed);
    await waitFor(() => expect(document.activeElement).toBe(drawn));
  });
});
