// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActivityPage, type ActivityEntryView, type ActivityRowView } from './activity-page.tsx';

const row = (id: string, message: string, subject: string | null): ActivityRowView => ({
  id,
  time: 'Today 09:00',
  dateTime: '2026-10-06T09:00:00',
  level: 'info',
  kind: 'meeting',
  message,
  subject,
});

const ENTRIES: ActivityEntryView[] = [
  {
    group: 'meeting',
    id: '3',
    title: '2026-10-06 Standup',
    rows: [
      {
        ...row('4', 'After a meeting: Ran by hand (Standup).', 'After a meeting'),
        kind: 'automation',
      },
      row('3', '2026-10-06 Standup: linked Mara Quill.', '2026-10-06 Standup'),
      row('2', '2026-10-06 Standup: imported.', '2026-10-06 Standup'),
    ],
  },
  { ...row('1', 'Sync pulled 2 notes.', null), kind: 'sync' },
];

function page(rows: readonly ActivityEntryView[] = ENTRIES) {
  const onOpenSubject = vi.fn();
  render(
    <ActivityPage
      rows={rows}
      total={5}
      error={null}
      level="all"
      kinds={[]}
      text=""
      onLevel={vi.fn()}
      onToggleKind={vi.fn()}
      onText={vi.fn()}
      onOpenSubject={onOpenSubject}
    />,
  );
  return { onOpenSubject };
}

describe('a meeting’s lines on the Activity page (#192)', () => {
  it('shows its import, linking and rule lines under the meeting, in order', () => {
    page();
    const meeting = screen.getByRole('listitem', { name: 'Meeting 2026-10-06 Standup' });
    const under = within(
      within(meeting).getByRole('list', { name: 'Lines about 2026-10-06 Standup' }),
    ).getAllByRole('listitem');
    expect(under.map((line) => line.textContent)).toEqual([
      expect.stringContaining('After a meeting: Ran by hand (Standup).'),
      expect.stringContaining('linked Mara Quill.'),
      expect.stringContaining('imported.'),
    ]);
  });

  it('keeps a line about something else outside the meeting', () => {
    page();
    const meeting = screen.getByRole('listitem', { name: 'Meeting 2026-10-06 Standup' });
    expect(within(meeting).queryByText('Sync pulled 2 notes.')).toBeNull();
    expect(screen.getByText('Sync pulled 2 notes.')).toBeTruthy();
  });

  it('shows a meeting with no rule run, its import and linking under it', () => {
    const [meeting] = ENTRIES;
    if (meeting === undefined || !('group' in meeting)) throw new Error('a meeting first');
    page([{ ...meeting, rows: meeting.rows.slice(1) }]);
    const under = within(
      screen.getByRole('list', { name: 'Lines about 2026-10-06 Standup' }),
    ).getAllByRole('listitem');
    expect(under).toHaveLength(2);
  });

  it('opens the meeting from its heading, by the line that names it', async () => {
    const { onOpenSubject } = page();
    const meeting = screen.getByRole('listitem', { name: 'Meeting 2026-10-06 Standup' });
    const heading = meeting.querySelector('.activity-group__head');
    if (!(heading instanceof HTMLElement)) throw new Error('the meeting has a heading');
    await userEvent.click(within(heading).getByRole('button', { name: /Open 2026-10-06 Standup/ }));
    expect(onOpenSubject).toHaveBeenCalledWith('3');
  });
});
