import { wallTimeOf, type DueMoment, type ReviewMoment } from '@dfai/domain';
import type { Clock } from '../ports.ts';

/**
 * The clock a read is measured on: the day, and the wall time (#928). A
 * clock that does not tell the wall time leaves a timed due today not yet
 * past, as every due was before #928; the app's clock tells it.
 */
export type DueClock = Pick<Clock, 'today'> & Partial<Pick<Clock, 'localNow'>>;

/** The clock a review read is measured on: a {@link DueClock}, and the instant. */
export type ReviewClock = DueClock & Pick<Clock, 'now'>;

/**
 * The day and the wall-clock time the due rules are measured against, read
 * from the clock once: both from its local now, so a read across midnight
 * cannot take one day's date and the next day's time; the day alone where
 * the clock does not tell the time.
 */
export function dueMomentOf(clock: DueClock): Required<DueMoment> {
  const localNow = clock.localNow?.() ?? null;
  const time = localNow === null ? null : wallTimeOf(localNow);
  return time === null || localNow === null
    ? { today: clock.today(), time: null }
    : { today: localNow.slice(0, 10), time };
}

/** The moment the review's and Today's rules are measured against: {@link dueMomentOf}, and the instant. */
export function reviewMomentOf(clock: ReviewClock): ReviewMoment {
  return { ...dueMomentOf(clock), now: clock.now() };
}

/**
 * The wall time a read of `day` is measured at: the clock's, when `day` is
 * the clock's today; none for another day, whose dues are read by their day.
 */
export function wallTimeOn(clock: DueClock, day: string): string | null {
  const moment = dueMomentOf(clock);
  return moment.today === day ? moment.time : null;
}
