// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DryRunResult } from './run-log-view.tsx';

const MEETING = 'Inbox/Meetings/2026-10-06 Standup.md';

describe('a dry run of the "After a meeting" rule (#192)', () => {
  it('lists the meetings not linked, each a click from opening', async () => {
    const onOpenNote = vi.fn();
    render(
      <DryRunResult
        result={{
          kind: 'plan',
          summary: '1 meeting is not linked: Run now links it first.',
          notes: [],
          passedOver: [],
          notLinked: [{ path: MEETING, title: '2026-10-06 Standup' }],
        }}
        onOpenNote={onOpenNote}
      />,
    );
    const list = screen.getByRole('list', { name: 'Meetings not linked' });
    expect(within(list).getByText('Not linked')).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: '2026-10-06 Standup' }));
    expect(onOpenNote).toHaveBeenCalledWith(MEETING);
  });

  it('lists none when every meeting is linked', () => {
    render(
      <DryRunResult
        result={{ kind: 'plan', summary: 'Nothing to do right now.', notes: [], passedOver: [] }}
        onOpenNote={vi.fn()}
      />,
    );
    expect(screen.getByText('Nothing to do right now.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Meetings not linked' })).toBeNull();
  });
});
