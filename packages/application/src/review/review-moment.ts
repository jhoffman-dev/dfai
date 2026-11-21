import { wallTimeOf, type ReviewMoment } from '@dfai/domain';
import type { Clock } from '../ports.ts';

/**
 * The clock a review read is measured on: the day, the instant, and the wall
 * time (#928). A clock that does not tell the wall time leaves a timed due
 * today not yet past, as every due was before #928; the app's clock tells it.
 */
export type ReviewClock = Pick<Clock, 'today' | 'now'> & Partial<Pick<Clock, 'localNow'>>;

/**
 * The moment the review's and Today's rules are measured against, read from
 * the clock once: its day, its instant, and its wall-clock time — what a
 * timed due today has passed by.
 */
export function reviewMomentOf(clock: ReviewClock): ReviewMoment {
  const localNow = clock.localNow?.() ?? null;
  return {
    today: clock.today(),
    now: clock.now(),
    time: localNow === null ? null : wallTimeOf(localNow),
  };
}
