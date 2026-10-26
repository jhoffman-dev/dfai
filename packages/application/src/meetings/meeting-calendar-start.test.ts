/**
 * The receive use-case's calendar step: for a meeting that carries no start,
 * the day's event notes are read through the index's day query (ADR-0046)
 * and handed to the domain's rule for which event it was. All names are made up.
 */
import { describe, expect, it } from 'vitest';
import type { MeetingFields } from '@dfai/domain';
import { fakeIndexPort } from '../testing/fake-ports.ts';
import { meetingCalendarStart } from './meeting-calendar-start.ts';

const OPTIONS = { timeZone: 'America/Los_Angeles' };

const SENT: MeetingFields = {
  source: 'gemini',
  sourceId: '19a2b3c4d5e6f799',
  title: 'Larkspur Payroll onboarding sync',
  stated: 'Notes: “Larkspur Payroll onboarding sync” Oct 24, 2026',
  arrived: '2026-10-24T17:40:00Z',
};

/** An event note's rows, as the day query answers them. */
function eventRows(path: string, values: Record<string, string>): unknown[][] {
  return Object.entries(values).map(([key, value]) => [
    path,
    'Larkspur Payroll onboarding sync',
    key,
    value,
  ]);
}

/** A fake index that answers the day query from these event-note rows, and records what it was asked. */
function eventNotes(rows: unknown[][]) {
  const asked: unknown[][] = [];
  const index = fakeIndexPort({
    query: async (sql, parameters) => {
      asked.push([sql, parameters]);
      return { columns: ['path', 'title', 'key', 'value'], rows, truncated: false };
    },
  });
  return { index, asked };
}

const SYNC = eventRows('Calendar/2026-10-24 Larkspur Payroll onboarding sync.md', {
  date: '2026-10-24T10:00',
  ends: '2026-10-24T10:30',
  gcal_event_id: 'ev-sync',
  gcal_response: 'accepted',
});

describe('meetingCalendarStart', () => {
  it('reads the stated day’s event notes and takes the matching event’s start and end', async () => {
    const { index, asked } = eventNotes(SYNC);
    const start = await meetingCalendarStart({ index, fields: SENT, options: OPTIONS });
    expect(start).toEqual({ found: true, start: '10:00', end: '10:30' });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.[1]).toContain('2026-10-24');
  });

  it('reads nothing when the meeting carries its own start', async () => {
    const { index, asked } = eventNotes(SYNC);
    const start = await meetingCalendarStart({
      index,
      fields: { ...SENT, start: '10:05' },
      options: OPTIONS,
    });
    expect(start).toBeNull();
    expect(asked).toEqual([]);
  });

  it('answers not found, asking for the calendar, when the day has no event notes', async () => {
    const { index } = eventNotes([]);
    const start = await meetingCalendarStart({ index, fields: SENT, options: OPTIONS });
    expect(start).toMatchObject({ found: false, connect: true });
  });

  it('answers not found when two events of the title fit', async () => {
    const twin = eventRows('Calendar/2026-10-24 Larkspur Payroll onboarding sync 2.md', {
      date: '2026-10-24T09:00',
      ends: '2026-10-24T09:30',
      gcal_event_id: 'ev-sync-2',
      gcal_response: 'accepted',
    });
    const { index } = eventNotes([...SYNC, ...twin]);
    const start = await meetingCalendarStart({ index, fields: SENT, options: OPTIONS });
    expect(start).toMatchObject({ found: false, connect: false });
  });

  it('passes on an index that cannot answer, rather than taking it as no calendar', async () => {
    const index = fakeIndexPort({
      query: async () => {
        throw new Error('index closed');
      },
    });
    await expect(meetingCalendarStart({ index, fields: SENT, options: OPTIONS })).rejects.toThrow(
      'index closed',
    );
  });
});
