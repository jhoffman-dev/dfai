import { weeklyReview, type WeeklyReview } from '@dfai/domain';
import { reviewMomentOf, type ReviewClock } from './review-moment.ts';
import {
  readReviewSources,
  type InboxCount,
  type InboxRule,
  type ReviewReadPorts,
} from './review-reads.ts';

/** The weekly review as it is shown: its sections, and what waits in the Inbox. */
export interface WeeklyReviewReport extends WeeklyReview {
  /** The day the review was taken, `YYYY-MM-DD`. */
  readonly today: string;
  readonly inbox: InboxCount;
  /** The index held rows back, so a section may be missing items. */
  readonly truncated: boolean;
}

/**
 * Takes the weekly review (P30-07): every open task and every project, read
 * from the index and put through the review's rules on the injected clock,
 * with the Inbox counted as the sidebar counts it: notes to file and
 * proposals to answer.
 */
export async function readWeeklyReview({
  clock,
  ...reads
}: ReviewReadPorts &
  InboxRule & {
    clock: ReviewClock;
  }): Promise<WeeklyReviewReport> {
  const { tasks, projects, inbox, truncated } = await readReviewSources(reads);
  const at = reviewMomentOf(clock);
  return { ...weeklyReview({ tasks, projects, at }), today: at.today, inbox, truncated };
}
