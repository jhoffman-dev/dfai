import { describe, expect, it } from 'vitest';
import { meetingWindow, startOfDayIn, wallEnd, wallStart } from './index.ts';

const at = (iso: string) => Date.parse(iso);

describe('startOfDayIn', () => {
  it('is the zone’s midnight on an ordinary day', () => {
    expect(startOfDayIn('2026-10-24', 'America/Los_Angeles')).toBe(at('2026-10-24T07:00:00Z'));
    expect(startOfDayIn('2026-10-24', 'Asia/Kolkata')).toBe(at('2026-10-23T18:30:00Z'));
    expect(startOfDayIn('2026-10-24', 'UTC')).toBe(at('2026-10-24T00:00:00Z'));
  });

  it('follows the offset on the days the clocks change, before and after midnight', () => {
    // New York springs forward at 02:00 on 2026-03-08 and falls back on 2026-11-01.
    expect(startOfDayIn('2026-03-08', 'America/New_York')).toBe(at('2026-03-08T05:00:00Z'));
    expect(startOfDayIn('2026-03-09', 'America/New_York')).toBe(at('2026-03-09T04:00:00Z'));
    expect(startOfDayIn('2026-11-01', 'America/New_York')).toBe(at('2026-11-01T04:00:00Z'));
    expect(startOfDayIn('2026-11-02', 'America/New_York')).toBe(at('2026-11-02T05:00:00Z'));
    // Lord Howe moves by half an hour.
    expect(startOfDayIn('2026-10-04', 'Australia/Lord_Howe')).toBe(at('2026-10-03T13:30:00Z'));
  });

  it('is the first instant of a day whose midnight the clocks skip', () => {
    // Santiago goes from 23:59:59 on 2026-09-05 straight to 01:00 on 2026-09-06.
    expect(startOfDayIn('2026-09-06', 'America/Santiago')).toBe(at('2026-09-06T04:00:00Z'));
  });
});

describe('meetingWindow', () => {
  it('reads yesterday to six days ahead, between the instants those days start', () => {
    expect(meetingWindow({ today: '2026-10-24', timeZone: 'America/Los_Angeles' })).toEqual({
      fromDay: '2026-10-23',
      toDay: '2026-10-30',
      timeMin: at('2026-10-23T07:00:00Z'),
      timeMax: at('2026-10-31T07:00:00Z'),
    });
  });

  it('spans a clock change as the wall clock does', () => {
    const window = meetingWindow({ today: '2026-10-31', timeZone: 'America/New_York' });
    expect(window?.timeMax).toBe(at('2026-11-07T05:00:00Z'));
    expect(window?.timeMin).toBe(at('2026-10-30T04:00:00Z'));
  });

  it('is null for a day that is not one', () => {
    expect(meetingWindow({ today: 'today', timeZone: 'UTC' })).toBeNull();
  });
});

describe('wallStart', () => {
  it('writes a timed event on the person’s wall clock, with no offset (ADR-0030)', () => {
    const nineAm = { kind: 'timed', at: at('2026-10-24T16:00:00Z') } as const;
    expect(wallStart(nineAm, 'America/Los_Angeles')).toBe('2026-10-24T09:00');
    expect(wallStart(nineAm, 'Europe/London')).toBe('2026-10-24T17:00');
  });

  it('keeps the wall-clock hour across a clock change', () => {
    // 09:00 in New York: EDT the day before the change, EST the day after.
    expect(wallStart({ kind: 'timed', at: at('2026-10-31T13:00:00Z') }, 'America/New_York')).toBe(
      '2026-10-31T09:00',
    );
    expect(wallStart({ kind: 'timed', at: at('2026-11-02T14:00:00Z') }, 'America/New_York')).toBe(
      '2026-11-02T09:00',
    );
  });

  it('puts an evening meeting in UTC on the next day where the person is', () => {
    expect(wallStart({ kind: 'timed', at: at('2026-10-24T22:30:00Z') }, 'Asia/Tokyo')).toBe(
      '2026-10-25T07:30',
    );
  });

  it('writes an all-day event as its day, in no zone', () => {
    expect(wallStart({ kind: 'day', date: '2026-10-24' }, 'Asia/Tokyo')).toBe('2026-10-24');
  });
});

describe('wallEnd', () => {
  const day = (date: string) => ({ kind: 'day', date }) as const;

  it('names the last day of an all-day event, which Google gives as the day after', () => {
    expect(wallEnd(day('2026-10-24'), day('2026-10-27'), 'UTC')).toBe('2026-10-26');
  });

  it('says nothing for a one-day event, which ends the day it starts', () => {
    expect(wallEnd(day('2026-10-24'), day('2026-10-25'), 'UTC')).toBeNull();
  });

  it('writes a timed end on the wall clock, and nothing for no end', () => {
    const start = { kind: 'timed', at: at('2026-10-24T16:00:00Z') } as const;
    const end = { kind: 'timed', at: at('2026-10-24T16:45:00Z') } as const;
    expect(wallEnd(start, end, 'America/Los_Angeles')).toBe('2026-10-24T09:45');
    expect(wallEnd(start, null, 'America/Los_Angeles')).toBeNull();
  });
});
