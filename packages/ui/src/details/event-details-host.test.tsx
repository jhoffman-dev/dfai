// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PeekDialog } from '../peek/peek-dialog.tsx';
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
    const { rerender } = render(
      <EventDetailsHost landmark={() => null}>{line(NOT_SAVED, opens)}</EventDetailsHost>,
    );
    await userEvent.click(screen.getByRole('button', { name: NOT_SAVED }));

    rerender(<EventDetailsHost landmark={() => null}>{line(NOT_MOVED)}</EventDetailsHost>);

    expect(screen.queryByRole('button', { name: NOT_SAVED })).toBeNull();
    expect(within(popup()).getByText(NOT_SAVED)).toBeTruthy();
    expect(within(popup()).queryByText(NOT_MOVED)).toBeNull();
    // What it could do, it still can: the link is the gone line's own.
    await userEvent.click(within(popup()).getByRole('button', { name: 'Open Greenhouse plan' }));
    expect(opens).toHaveBeenCalledTimes(1);
  });

  it('shows one line’s details at a time, and says which line is open', async () => {
    render(
      <EventDetailsHost landmark={() => null}>
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
    const { rerender } = render(
      <EventDetailsHost landmark={() => null}>{line(NOT_SAVED)}</EventDetailsHost>,
    );
    const pressed = screen.getByRole('button', { name: NOT_SAVED });
    await userEvent.click(pressed);

    // Gathered under something new: the same line, another element.
    rerender(
      <EventDetailsHost landmark={() => null}>
        <section>{line(NOT_SAVED)}</section>
      </EventDetailsHost>,
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const drawn = screen.getByRole('button', { name: NOT_SAVED });
    expect(drawn).not.toBe(pressed);
    await waitFor(() => expect(document.activeElement).toBe(drawn));
  });

  it('hands the focus to its landmark, never to the body, when the line is gone as it closes', async () => {
    const drawn = (lines: boolean) => (
      <EventDetailsHost landmark={() => screen.getByRole('list', { name: 'Lines', hidden: true })}>
        <ul aria-label="Lines" tabIndex={-1}>
          {lines && <li>{line(NOT_SAVED)}</li>}
        </ul>
      </EventDetailsHost>
    );
    const { rerender } = render(drawn(true));
    await userEvent.click(screen.getByRole('button', { name: NOT_SAVED }));

    rerender(drawn(false));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('list', { name: 'Lines' })),
    );
    expect(document.activeElement).not.toBe(document.body);
  });

  it('puts the focus on its landmark itself, never on another line in it that Tab stops on', async () => {
    const drawn = (...messages: string[]) => (
      <EventDetailsHost landmark={() => screen.getByRole('list', { name: 'Lines', hidden: true })}>
        <ul aria-label="Lines" tabIndex={-1}>
          {messages.map((message) => (
            <li key={message}>{line(message)}</li>
          ))}
        </ul>
      </EventDetailsHost>
    );
    const { rerender } = render(drawn(NOT_MOVED, NOT_SAVED));
    await userEvent.click(screen.getByRole('button', { name: NOT_SAVED }));

    rerender(drawn(NOT_MOVED));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Not the line left: an Enter meant for the one that went would press it.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('list', { name: 'Lines' })),
    );
  });

  it('brings its landmark into view, and shows the focus on it when the keyboard closed the popup', async () => {
    const focused = vi.spyOn(HTMLElement.prototype, 'focus');
    const drawn = (lines: boolean) => (
      <EventDetailsHost landmark={() => screen.getByRole('list', { name: 'Lines', hidden: true })}>
        <ul aria-label="Lines" tabIndex={-1}>
          {lines && <li>{line(NOT_SAVED)}</li>}
        </ul>
      </EventDetailsHost>
    );
    const { rerender } = render(drawn(true));
    await userEvent.click(screen.getByRole('button', { name: NOT_SAVED }));
    rerender(drawn(false));
    await userEvent.keyboard('{Escape}');
    const list = screen.getByRole('list', { name: 'Lines' });
    await waitFor(() => expect(document.activeElement).toBe(list));

    const options = focused.mock.calls[focused.mock.contexts.lastIndexOf(list)]?.[0];
    expect(options?.preventScroll ?? false).toBe(false);
    expect(options).toMatchObject({ focusVisible: true });
    focused.mockRestore();
  });

  /** Opens a line's details, takes the line away, closes them with `close`, and answers how the list was focused. */
  async function focusOptionsAfter(close: () => Promise<void> | void) {
    const focused = vi.spyOn(HTMLElement.prototype, 'focus');
    const drawn = (lines: boolean) => (
      <EventDetailsHost landmark={() => screen.getByRole('list', { name: 'Lines', hidden: true })}>
        <ul aria-label="Lines" tabIndex={-1}>
          {lines && <li>{line(NOT_SAVED)}</li>}
        </ul>
      </EventDetailsHost>
    );
    const { rerender } = render(drawn(true));
    await userEvent.click(screen.getByRole('button', { name: NOT_SAVED }));
    rerender(drawn(false));
    await close();
    const list = screen.getByRole('list', { name: 'Lines' });
    await waitFor(() => expect(document.activeElement).toBe(list));
    const options = focused.mock.calls[focused.mock.contexts.lastIndexOf(list)]?.[0];
    focused.mockRestore();
    return options;
  }

  /** A mouse's press of one of the popup's buttons, said as a mouse's: jsdom's own pointer has no type. */
  function pressWithPointer(name: string): void {
    const button = within(popup()).getByRole('button', { name });
    fireEvent.pointerDown(button, { pointerType: 'mouse' });
    fireEvent.click(button, { detail: 1 });
  }

  it('shows the focus on its landmark when the Escape was its own to take, before the dialog heard it', async () => {
    // On the body: the focus has not reached the popup, so the dialog's own Escape is not in play.
    const options = await focusOptionsAfter(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    expect(options).toMatchObject({ focusVisible: true });
  });

  it('shows the focus on its landmark when a key pressed "Open subject"', async () => {
    const options = await focusOptionsAfter(async () => {
      within(popup()).getByRole('button', { name: 'Open Greenhouse plan' }).focus();
      await userEvent.keyboard('{Enter}');
    });
    expect(options).toMatchObject({ focusVisible: true });
  });

  it('shows no focus on its landmark when the pointer closed the popup', async () => {
    const options = await focusOptionsAfter(() => pressWithPointer('Close'));
    expect(options).toMatchObject({ focusVisible: false });
  });

  it('shows no focus on its landmark when the pointer pressed "Open subject"', async () => {
    const options = await focusOptionsAfter(() => pressWithPointer('Open Greenhouse plan'));
    expect(options).toMatchObject({ focusVisible: false });
  });

  it('reads details given as a function when the line is pressed, not when it is drawn', async () => {
    let said = NOT_SAVED;
    render(
      <EventDetailsHost landmark={() => null}>
        <EventDetailsButton details={() => details(said)} onCopy={() => Promise.resolve()}>
          A line
        </EventDetailsButton>
      </EventDetailsHost>,
    );
    said = NOT_MOVED;
    await userEvent.click(screen.getByRole('button', { name: 'A line' }));
    expect(within(popup()).getByText(NOT_MOVED)).toBeTruthy();
  });

  it('tells a line drawn again elsewhere that its details are still open', async () => {
    const told = vi.fn();
    const watched = (
      <EventDetailsButton
        id="watched"
        details={details(NOT_SAVED)}
        onCopy={() => Promise.resolve()}
        onOpenChange={told}
      >
        {NOT_SAVED}
      </EventDetailsButton>
    );
    const { rerender } = render(
      <EventDetailsHost landmark={() => null}>{watched}</EventDetailsHost>,
    );
    expect(told).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: NOT_SAVED }));
    expect(told.mock.calls).toEqual([[true]]);

    rerender(
      <EventDetailsHost landmark={() => null}>
        <section>{watched}</section>
      </EventDetailsHost>,
    );

    expect(told.mock.calls).toEqual([[true], [true]]);
  });

  it('takes an Escape pressed while the focus is still on its line, so the peek under it stays', async () => {
    const onClose = vi.fn();
    render(
      <EventDetailsHost landmark={() => null}>
        <PeekDialog
          title="Plan the harvest"
          position={null}
          status="Saved"
          onStep={vi.fn()}
          onClose={onClose}
        >
          {line(NOT_SAVED)}
        </PeekDialog>
      </EventDetailsHost>,
    );
    const pressed = screen.getByRole('button', { name: NOT_SAVED });
    fireEvent.click(pressed);
    expect(popup()).toBeTruthy();

    // The key comes before the focus has left the line, which is in the peek: the popup's all the same.
    const leftAlone = fireEvent.keyDown(pressed, { key: 'Escape' });

    expect(leftAlone).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Error details' })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Plan the harvest' })).toBeTruthy();
  });

  it('leaves an Escape alone while no details are open', () => {
    render(<EventDetailsHost landmark={() => null}>{line(NOT_SAVED)}</EventDetailsHost>);
    expect(
      fireEvent.keyDown(screen.getByRole('button', { name: NOT_SAVED }), { key: 'Escape' }),
    ).toBe(true);
  });
});
