// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { EVERY_ACTIVITY, createVaultPath, type ActivityEvent } from '@dfai/domain';
import { ActivityScreen } from './activity-screen.tsx';

/** #815, attacked: the details of a line while the log moves under it. Each `it.fails` is a bug. */

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

function screenOf(shown: readonly ActivityEvent[]) {
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
  it.fails(
    'keeps a meeting line’s details open when a rule’s run arrives about that meeting',
    () => {
      const { rerender } = render(screenOf([NOT_LINKED]));
      fireEvent.click(screen.getByRole('button', { name: NOT_LINKED.message }));
      expect(screen.getByRole('dialog', { name: 'Warning details' })).toBeTruthy();

      // A rule hears the meeting a moment later: the line is now gathered under it.
      rerender(screenOf([RULE_HEARD, NOT_LINKED]));

      expect(screen.queryByRole('dialog', { name: 'Warning details' })).not.toBeNull();
    },
  );

  it.fails(
    'keeps showing the line that was opened when the log is read again without its oldest',
    () => {
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
    },
  );
});
