import { choosesForToday, todayLists, type TodayLists } from '@dfai/domain';
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
  ...reads
}: ReviewReadPorts &
  InboxRule & {
    clock: Pick<Clock, 'today' | 'now'>;
    choosing?: boolean;
  }): Promise<TodayReport> {
  const [{ tasks, projects, inbox, truncated }, chooses] = await Promise.all([
    readReviewSources(reads),
    choosing ?? loadObjectTypes({ fs: reads.fs, markdown: reads.markdown }).then(choosesForToday),
  ]);
  const at = { today: clock.today(), now: clock.now() };
  return {
    ...todayLists({ tasks, projects, at, choosing: chooses }),
    today: at.today,
    choosing: chooses,
    inbox,
    truncated,
  };
}
