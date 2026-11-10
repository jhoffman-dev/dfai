// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActivityPage, type ActivityRowView } from './activity-page.tsx';

/** #815: a warning or an error line of the Activity page opens to its details. */

const REFUSED: ActivityRowView = {
  id: '2',
  time: 'Today, 13:00',
  dateTime: '2026-09-28T13:00:00',
  level: 'warning',
  kind: 'api',
  message: 'PUT v1/notes/{path}/body refused for Call (conflict).',
  subject: null,
  details: {
    level: 'warning',
    time: 'Today, 13:00',
    dateTime: '2026-09-28T13:00:00',
    message: 'PUT v1/notes/{path}/body refused for Call (conflict).',
    subject: null,
    details: [{ label: 'Reason', value: 'The note changed since it was read.' }],
    text: 'Warning · Today, 13:00',
  },
};

const FAILED: ActivityRowView = {
  id: '3',
  time: 'Today, 14:03',
  dateTime: '2026-09-28T14:03:00',
  level: 'error',
  kind: 'automation',
  message: 'Tidy tasks: Could not run. disk full',
  subject: 'Tidy tasks',
  details: {
    level: 'error',
    time: 'Today, 14:03',
    dateTime: '2026-09-28T14:03:00',
    message: 'Tidy tasks: Could not run. disk full',
    subject: 'Tidy tasks',
    details: [{ label: 'Problem', value: 'disk full' }],
    text: 'Error · Today, 14:03',
  },
};

const RAN: ActivityRowView = {
  id: '1',
  time: 'Yesterday, 03:00',
  dateTime: '2026-09-27T03:00:00',
  level: 'info',
  kind: 'automation',
  message: 'Tidy tasks: Ran on schedule. Archived 2 notes.',
  subject: 'Tidy tasks',
};

function page() {
  const handlers = {
    onLevel: vi.fn(),
    onToggleKind: vi.fn(),
    onText: vi.fn(),
    onOpenSubject: vi.fn(),
    onCopy: vi.fn(() => Promise.resolve()),
  };
  const rows = [FAILED, REFUSED, RAN];
  render(
    <ActivityPage
      rows={rows}
      total={rows.length}
      error={null}
      level="all"
      kinds={[]}
      text=""
      {...handlers}
    />,
  );
  return handlers;
}

const line = (message: string) => screen.getByRole('button', { name: message });

describe('ActivityPage — a line opens to its details', () => {
  it('opens a warning on a click, and closes it on Escape', async () => {
    page();
    await userEvent.click(line(REFUSED.message));
    const popup = screen.getByRole('dialog', { name: 'Warning details' });
    expect(within(popup).getByText('Today, 13:00')).toBeTruthy();
    expect(within(popup).getByText(REFUSED.message)).toBeTruthy();
    expect(within(popup).getByText('The note changed since it was read.')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens an error from the keyboard, on Enter', async () => {
    page();
    line(FAILED.message).focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Error details' })).toBeTruthy();
  });

  it("opens the line's subject from its details, by the line's id", async () => {
    const { onOpenSubject } = page();
    await userEvent.click(line(FAILED.message));
    const popup = screen.getByRole('dialog', { name: 'Error details' });
    await userEvent.click(within(popup).getByRole('button', { name: 'Open Tidy tasks' }));
    expect(onOpenSubject).toHaveBeenCalledWith('3');
  });

  it('copies the details of the line opened', async () => {
    const { onCopy } = page();
    await userEvent.click(line(REFUSED.message));
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenCalledWith('Warning · Today, 13:00');
  });

  it('keeps a line without details as words alone, cut short, with the whole in its title', () => {
    page();
    expect(screen.queryByRole('button', { name: RAN.message })).toBeNull();
    expect(screen.getByText(RAN.message).getAttribute('title')).toBe(RAN.message);
  });

  it('keeps the whole message in the title of a line that opens, too', () => {
    page();
    expect(line(REFUSED.message).getAttribute('title')).toBe(REFUSED.message);
  });

  it('draws the line that opens as the message was, so it is still cut to one line', () => {
    page();
    expect(line(REFUSED.message).className.split(' ')).toContain('activity-line__message');
  });

  it('hands the focus to the list’s first line when the details close with their line trimmed away', async () => {
    const drawn = (rows: ActivityRowView[]) => (
      <ActivityPage
        rows={rows}
        total={rows.length}
        error={null}
        level="all"
        kinds={[]}
        text=""
        onLevel={vi.fn()}
        onToggleKind={vi.fn()}
        onText={vi.fn()}
        onOpenSubject={vi.fn()}
        onCopy={() => Promise.resolve()}
      />
    );
    const { rerender } = render(drawn([FAILED, REFUSED, RAN]));
    await userEvent.click(line(REFUSED.message));

    rerender(drawn([FAILED, RAN]));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The list, which puts it on the first thing in it that Tab stops on.
    await waitFor(() => expect(document.activeElement).toBe(line(FAILED.message)));

    // No line left to list: the page, at its first control.
    await userEvent.click(line(FAILED.message));
    rerender(drawn([]));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const article = screen.getByRole('article', { name: 'Activity' });
    await waitFor(() => expect(article.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(document.body);
  });
});
