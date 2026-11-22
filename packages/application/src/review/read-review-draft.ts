import {
  compileReviewDoneQuery,
  compileReviewMeetingsQuery,
  reviewDraftData,
  reviewDraftWindow,
  reviewSource,
  type LocalTime,
  type ReviewDraftData,
} from '@dfai/domain';
import type { ReviewClock } from './review-moment.ts';
import { readWeeklyReview } from './read-weekly-review.ts';
import { rowsOf, type ReviewReadPorts } from './review-reads.ts';

/**
 * What the Friday review draft (#40) is handed, read at one moment on the
 * injected clock: the weekly review as its page shows it, with the tasks
 * finished and the meetings held in the week `week` names — from the slot
 * before it to its own — and the notes the draft may cite.
 */
export async function readReviewDraft({
  clock,
  week,
  ...reads
}: ReviewReadPorts & {
  clock: ReviewClock;
  /** The slot the draft is for, and the wall clock at `clock.now()`. */
  week: { slot: LocalTime; localNow: LocalTime };
}): Promise<ReviewDraftData> {
  const now = clock.now();
  const today = clock.today();
  const localNow = clock.localNow?.();
  const window = reviewDraftWindow({ ...week, now });
  const [report, done, meetings] = await Promise.all([
    readWeeklyReview({
      clock: {
        today: () => today,
        now: () => now,
        ...(localNow !== undefined && { localNow: () => localNow }),
      },
      ...reads,
    }),
    rowsOf(reads.index, compileReviewDoneQuery(window.since, window)),
    rowsOf(reads.index, compileReviewMeetingsQuery(window)),
  ]);
  return reviewDraftData({
    review: report,
    done: done.rows.map(reviewSource),
    meetings: meetings.rows.map(reviewSource),
    inbox: report.inbox,
    truncated: report.truncated || done.truncated || meetings.truncated,
    today,
    now,
  });
}
