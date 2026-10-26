import { keepsCalendarClock, wallDayIn, wallTimeIn, type AutomationRule } from '@dfai/domain';
import type { Clock } from '../ports.ts';

/** What a run reads the time from. */
export type RunClock = Pick<Clock, 'today' | 'now' | 'localNow'>;

/** A clock that reads `timeZone`'s wall clock at the instants `clock` gives (#587). */
export function clockOnZone(clock: Pick<Clock, 'now'>, timeZone: string): RunClock {
  return {
    now: () => clock.now(),
    today: () => wallDayIn(timeZone, clock.now()),
    localNow: () => wallTimeIn(timeZone, clock.now()),
  };
}

/**
 * The clock a rule runs on: the plan zone's for one that keeps the
 * calendar's clock (the morning brief, #587) in a vault that keeps a zone,
 * so its slot, its day and its log are on the event notes' clock; else
 * `clock`, the Mac's.
 */
export function clockForRule({
  rule,
  clock,
  planZone,
}: {
  rule: Pick<AutomationRule, 'action'>;
  clock: RunClock;
  planZone: string | null;
}): RunClock {
  return planZone !== null && keepsCalendarClock(rule) ? clockOnZone(clock, planZone) : clock;
}

/** The plan zone's wall clock now, as `ruleClockOf` is handed it; null when the vault keeps no zone. */
export function planNowOf(clock: Pick<Clock, 'now'>, planZone: string | null): string | null {
  return planZone === null ? null : wallTimeIn(planZone, clock.now());
}
