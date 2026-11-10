// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EVERY_ACTIVITY, createVaultPath, type ActivityEvent } from '@dfai/domain';
import { ActivityScreen } from './activity-screen.tsx';

/** #815, attacked: the details of a line while the log moves under it. Each was a bug, and is held to here. */

// Built from local parts, so the test reads the same in any timezone.
const AT = new Date(2026, 8, 28, 14, 3).getTime();
const CLOCK = { today: () => '2026-09-28' };
const STANDUP = createVaultPath('Meetings/Orchard standup.md');

const NOT_LINKED: ActivityEvent = {
  at: AT,
  level: 'warning',
  kind: 'meeting',
  message: 'Orchard standup: two people could not be linked.',
  subject: { kind: 'note', path: STANDUP },
};
const RULE_HEARD: ActivityEvent = {
  at: AT + 2000,
  level: 'info',
  kind: 'automation',
  message: 'File meetings ran on Orchard standup.',
  subject: null,
  notes: [STANDUP],
};
const OLDER: ActivityEvent = {
  at: AT - 60_000,
  level: 'error',
  kind: 'app',
  message: 'Could not save Greenhouse plan.',
  subject: null,
};

function screenOf(shown: ActivityEvent[]) {
  return (
    <ActivityScreen
      activity={{
        shown,
        total: shown.length,
        error: null,
        query: EVERY_ACTIVITY,
        setQuery: vi.fn(),
        unseenErrors: 0,
      }}
      clock={CLOCK}
      clipboard={{ write: () => Promise.resolve() }}
      onOpenSubject={vi.fn()}
    />
  );
}

describe('ActivityScreen — details while the log moves', () => {
  it('keeps a meeting line’s details open when a rule’s run arrives about that meeting', () => {
    const { rerender } = render(screenOf([NOT_LINKED]));
    fireEvent.click(screen.getByRole('button', { name: NOT_LINKED.message }));
    expect(screen.getByRole('dialog', { name: 'Warning details' })).toBeTruthy();

    // A rule hears the meeting a moment later: the line is now gathered under it.
    rerender(screenOf([RULE_HEARD, NOT_LINKED]));

    expect(screen.queryByRole('dialog', { name: 'Warning details' })).not.toBeNull();
  });

  it('keeps showing the line that was opened when the log is read again without its oldest', () => {
    const { rerender } = render(
      screenOf([NOT_LINKED, OLDER, { ...OLDER, at: AT - 120_000, message: 'Oldest line.' }]),
    );
    fireEvent.click(screen.getByRole('button', { name: OLDER.message }));
    const before = screen.getByRole('dialog', { name: 'Error details' });
    expect(within(before).getByText(OLDER.message)).toBeTruthy();

    // The oldest line expires and the page reads the log again.
    rerender(screenOf([NOT_LINKED, OLDER]));

    const popup = screen.queryByRole('dialog');
    // Either it is still the error that was opened, or it has closed: never another line's.
    expect(popup === null || within(popup).queryByText(OLDER.message) !== null).toBe(true);
  });

  it('keeps a twin’s details on its own words, and the focus on a line or the list, when its older twin is trimmed', async () => {
    // Two lines alike in moment and words, told apart only by what more each says.
    const first: ActivityEvent = { ...OLDER, detail: 'The disk is full.' };
    const second: ActivityEvent = { ...OLDER, detail: 'The folder is read-only.' };
    const { rerender } = render(screenOf([NOT_LINKED, second, first]));
    const [newer] = screen.getAllByRole('button', { name: OLDER.message });
    if (newer === undefined) throw new Error('the twins are drawn');
    await userEvent.click(newer);
    expect(within(screen.getByRole('dialog')).getByText('The folder is read-only.')).toBeTruthy();

    // The older twin expires: the one left takes its id, and none has the id that was pressed.
    rerender(screenOf([NOT_LINKED, second]));

    const popup = screen.getByRole('dialog', { name: 'Error details' });
    expect(within(popup).getByText('The folder is read-only.')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // No line has the pressed id now, so the list takes the focus: itself, never a line left in it.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('list', { name: 'Activity lines' })),
    );
  });
});
