// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createVaultPath } from '@dfai/domain';
import { TodayMeetings, type TodayMeetingRow } from './today-meetings.tsx';

const row = (overrides: Partial<TodayMeetingRow> = {}): TodayMeetingRow => ({
  path: createVaultPath('Calendar/2026-10-24 Payroll standup.md'),
  title: 'Payroll standup',
  time: '09:00–09:30',
  people: ['Mara Quill', 'Tobias Fenn'],
  unanswered: false,
  ...overrides,
});

describe('TodayMeetings (ADR-0046)', () => {
  it('lists each meeting with its time and who it is with, and opens its note', async () => {
    const onOpen = vi.fn();
    render(
      <TodayMeetings
        meetings={[
          row(),
          row({
            path: createVaultPath('Calendar/Review.md'),
            title: 'Vendor review',
            time: '14:00',
            people: [],
            unanswered: true,
          }),
        ]}
        onOpen={onOpen}
      />,
    );
    const section = screen.getByRole('region', { name: 'Meetings' });
    const items = within(section).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      '09:00–09:30Payroll standupwith Mara Quill, Tobias Fenn',
      '14:00Vendor reviewnot answered',
    ]);
    await userEvent.click(within(section).getByRole('button', { name: /Vendor review/ }));
    expect(onOpen).toHaveBeenCalledWith('Calendar/Review.md');
  });

  it('draws nothing on a day with no meetings', () => {
    const { container } = render(<TodayMeetings meetings={[]} onOpen={vi.fn()} />);
    expect(container.childElementCount).toBe(0);
  });
});
