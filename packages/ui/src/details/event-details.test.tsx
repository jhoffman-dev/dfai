// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EventDetailsButton, type EventDetailsView } from './event-details.tsx';

const FAILED: EventDetailsView = {
  level: 'error',
  time: 'Today, 14:03',
  dateTime: '2026-09-28T14:03:00',
  message: 'Tidy tasks: Could not run. The archive folder could not be made.',
  subject: 'Tidy tasks',
  details: [
    { label: 'Problem', value: 'The archive folder could not be made: the disk is full.' },
    { label: 'Notes', value: 'Standup, Kickoff' },
  ],
  text: 'Error · Today, 14:03\nTidy tasks: Could not run.',
};

function shown(details: EventDetailsView = FAILED, onCopy = vi.fn(() => Promise.resolve())) {
  const handlers = { onCopy, onOpenSubject: vi.fn(), onOpenChange: vi.fn() };
  render(
    <EventDetailsButton details={details} className="line" {...handlers}>
      Could not run
    </EventDetailsButton>,
  );
  return handlers;
}

const entry = () => screen.getByRole('button', { name: 'Could not run' });
const popup = () => screen.getByRole('dialog', { name: 'Error details' });

describe('EventDetailsButton', () => {
  it('shows only its words until it is opened', () => {
    shown();
    expect(entry().className).toContain('line');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on a click, with the level, the time, the whole message and each detail', async () => {
    const { onOpenChange } = shown();
    await userEvent.click(entry());

    expect(within(popup()).getByText('Error')).toBeTruthy();
    const time = within(popup()).getByText('Today, 14:03');
    expect(time.getAttribute('datetime')).toBe('2026-09-28T14:03:00');
    expect(within(popup()).getByText(FAILED.message)).toBeTruthy();
    const facts = within(popup()).getAllByRole('term');
    expect(facts.map((fact) => fact.textContent)).toEqual(['About', 'Problem', 'Notes']);
    expect(
      within(popup()).getByText('The archive folder could not be made: the disk is full.'),
    ).toBeTruthy();
    expect(within(popup()).getByText('Standup, Kickoff')).toBeTruthy();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });

  it('opens from the keyboard, on Enter and on Space', async () => {
    shown();
    await userEvent.tab();
    expect(document.activeElement).toBe(entry());
    await userEvent.keyboard('{Enter}');
    expect(popup()).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    entry().focus();
    await userEvent.keyboard(' ');
    expect(popup()).toBeTruthy();
  });

  it('closes on Escape, and says so', async () => {
    const { onOpenChange } = shown();
    await userEvent.click(entry());
    expect(popup()).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('closes by its Close button', async () => {
    shown();
    await userEvent.click(entry());
    await userEvent.click(within(popup()).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('names a warning as one', async () => {
    shown({ ...FAILED, level: 'warning' });
    await userEvent.click(entry());
    const warning = screen.getByRole('dialog', { name: 'Warning details' });
    expect(within(warning).getByText('Warning').className).toContain(
      'event-details__level--warning',
    );
  });

  it('opens what it is about, and closes', async () => {
    const { onOpenSubject } = shown();
    await userEvent.click(entry());
    await userEvent.click(within(popup()).getByRole('button', { name: 'Open Tidy tasks' }));
    expect(onOpenSubject).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('has no link and no facts for an event about nothing, with nothing more to say', async () => {
    shown({ ...FAILED, subject: null, details: [] });
    await userEvent.click(entry());
    expect(within(popup()).queryByRole('button', { name: /^Open / })).toBeNull();
    expect(within(popup()).queryByRole('term')).toBeNull();
  });

  it('copies its text, and says it has', async () => {
    const { onCopy } = shown();
    await userEvent.click(entry());
    await userEvent.click(within(popup()).getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenCalledWith(FAILED.text);
    expect(await within(popup()).findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('says when the clipboard refused', async () => {
    shown(
      FAILED,
      vi.fn(() => Promise.reject(new Error('denied'))),
    );
    await userEvent.click(entry());
    await userEvent.click(within(popup()).getByRole('button', { name: 'Copy' }));
    expect((await within(popup()).findByRole('alert')).textContent).toBe('Could not copy.');
    expect(within(popup()).getByRole('button', { name: 'Copy' })).toBeTruthy();
  });
});
