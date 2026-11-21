import {
  choosesForToday,
  ranksTasks,
  todayLists,
  type ReviewTask,
  type TodayLists,
} from '@dfai/domain';
import type { Clock } from '../ports.ts';
import {
  readReviewSources,
  type InboxCount,
  type InboxRule,
  type ReviewReadPorts,
} from '../review/review-reads.ts';
import { loadObjectTypes } from '../types/load-types.ts';

/** The Today page as it is shown: its sections, and what waits elsewhere. */
export interface TodayReport extends TodayLists {
  /** The day it was taken, `YYYY-MM-DD`, from the injected clock. */
  readonly today: string;
  /**
   * Whether tasks can be chosen for today (#108): the vault's Task type has
   * `focus` as a date. When not, nothing is chosen or carried over, and the
   * page offers no choice.
   */
  readonly choosing: boolean;
  readonly inbox: InboxCount;
  /** The index held rows back, so a section may be missing tasks. */
  readonly truncated: boolean;
}

/**
 * Reads the Today page (#111): the weekly review's reads — every open task
 * in one statement, the projects, the Inbox's count — put through the page's
 * rules on the injected clock, whose `today` is the day everything turns on.
 * Whether the vault chooses for today is the caller's to say when it holds
 * the vault's types; otherwise they are read.
 */
export async function readToday({
  clock,
  choosing,
  ranking,
  ...reads
}: ReviewReadPorts &
  InboxRule & {
    clock: Pick<Clock, 'today' | 'now'>;
    choosing?: boolean;
    /** Whether the vault's tasks are ranked 1 to 4 (`ranksTasks`, #913); read when not said. */
    ranking?: boolean;
  }): Promise<TodayReport> {
  const types =
    choosing === undefined || ranking === undefined
      ? loadObjectTypes({ fs: reads.fs, markdown: reads.markdown })
      : null;
  const [{ tasks, projects, inbox, truncated }, chooses, ranks] = await Promise.all([
    readReviewSources(reads),
    choosing ?? types?.then(choosesForToday) ?? false,
    ranking ?? types?.then(ranksTasks) ?? false,
  ]);
  const at = { today: clock.today(), now: clock.now() };
  // A vault that keeps a priority of its own is shown none of this feature's (#913).
  const listed = ranks ? tasks : tasks.map(withoutPriority);
  return {
    ...todayLists({ tasks: listed, projects, at, choosing: chooses }),
    today: at.today,
    choosing: chooses,
    inbox,
    truncated,
  };
}

/** A task with its priority left out, which a row then neither shows nor offers. */
function withoutPriority(task: ReviewTask): ReviewTask {
  return Object.fromEntries(
    Object.entries(task).filter(([key]) => key !== 'priority'),
  ) as unknown as ReviewTask;
}
