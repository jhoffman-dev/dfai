import { describe, expect, it } from 'vitest';
import { dueMomentOf, reviewMomentOf, wallTimeOn } from './review-moment.ts';

/** #928: the moment the due rules are measured against, read from the clock once. */
describe('dueMomentOf', () => {
  it('takes the day and the time from the local now, so a read across midnight is one moment', () => {
    // `today()` asked a moment before midnight, `localNow()` a moment after.
    const clock = { today: () => '2026-12-04', localNow: () => '2026-12-05T00:00:30' };
    expect(dueMomentOf(clock)).toEqual({ today: '2026-12-05', time: '00:00' });
  });

  it('takes the day alone from a clock that does not tell the time', () => {
    expect(dueMomentOf({ today: () => '2026-12-04' })).toEqual({ today: '2026-12-04', time: null });
    expect(dueMomentOf({ today: () => '2026-12-04', localNow: () => 'garbled' })).toEqual({
      today: '2026-12-04',
      time: null,
    });
  });

  it('adds the instant for the review', () => {
    const clock = {
      today: () => '2026-12-04',
      now: () => 7,
      localNow: () => '2026-12-04T15:31:00',
    };
    expect(reviewMomentOf(clock)).toEqual({ today: '2026-12-04', time: '15:31', now: 7 });
  });

  it('gives the wall time only for a read of the clock’s own day', () => {
    const clock = { today: () => '2026-12-04', localNow: () => '2026-12-04T15:31:00' };
    expect(wallTimeOn(clock, '2026-12-04')).toBe('15:31');
    expect(wallTimeOn(clock, '2026-12-03')).toBeNull();
  });
});
