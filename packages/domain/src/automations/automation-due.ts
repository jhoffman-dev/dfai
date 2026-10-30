import type { AutomationRule } from './automation-rule.ts';
import { SHARED_STEP_BUDGET, type ClaudeStepBudget } from './claude-step-budget.ts';
import { keepsCalendarClock } from './morning-brief.ts';
import { lastScheduleMark, type LogEntry, type RunTrigger } from './run-log.ts';
import { isDue, localTimeMs, localTimeOf, nextRunAfter, type LocalTime } from './schedule.ts';

interface RuleClock {
  readonly rule: AutomationRule;
  /** The rule's log, oldest first. */
  readonly log: readonly LogEntry[];
  readonly now: LocalTime;
  /**
   * When DFAI started watching this vault: what a rule with nothing in its
   * log — written by hand, never run — counts its first run from.
   */
  readonly watchingSince: LocalTime;
}

/**
 * Whether a rule should run now, and what to call the run; null when not.
 *
 * `opening` is the one check made when a vault is opened: a rule that runs on
 * opening runs then and only then, and a scheduled rule that missed its time
 * while DFAI was closed catches up — once, because the run it makes becomes
 * the mark its next time is counted from.
 */
export function dueTrigger({
  opening,
  ...clock
}: RuleClock & { opening: boolean }): RunTrigger | null {
  const { rule } = clock;
  if (!rule.enabled) return null;
  if (rule.when.kind === 'open') return opening ? 'open' : null;
  // A note trigger is set off by the change feed, never by the clock.
  if (rule.when.kind === 'manual' || rule.when.kind === 'note') return null;
  return isDue({ schedule: rule.when, since: sinceOf(clock), now: clock.now }) ? 'schedule' : null;
}

/** When a rule will next run by itself, for the list; null when it only runs on opening or by hand, or is off. */
export function nextRunOf(clock: RuleClock): LocalTime | null {
  if (!clock.rule.enabled) return null;
  return nextRunAfter(clock.rule.when, sinceOf(clock));
}

function sinceOf({ log, watchingSince, now }: Omit<RuleClock, 'rule'>): LocalTime {
  return lastScheduleMark(log, now) ?? watchingSince;
}

/**
 * The clock a rule is counted on (#587): the Mac's, except for a rule that
 * keeps the calendar's (`keepsCalendarClock`) in a vault that keeps a plan
 * zone, which is counted on `planNow`, that zone's wall clock now. When
 * watching began is moved by the same gap, so a rule never run counts its
 * first run from the same instant on either clock. The rule's log is
 * written on the clock it is counted on, so its marks need no moving.
 */
export function ruleClockOf({
  rule,
  now,
  watchingSince,
  planNow,
}: {
  rule: Pick<AutomationRule, 'action'>;
  now: LocalTime;
  watchingSince: LocalTime;
  /** The plan zone's wall clock now; null when the vault keeps no zone. */
  planNow: LocalTime | null;
}): { now: LocalTime; watchingSince: LocalTime } {
  if (planNow === null || !keepsCalendarClock(rule)) return { now, watchingSince };
  const gap = (localTimeMs(planNow) ?? 0) - (localTimeMs(now) ?? 0);
  const since = localTimeMs(watchingSince);
  return {
    now: planNow,
    watchingSince: since === null ? watchingSince : localTimeOf(since + gap),
  };
}

/** The longest a failing rule waits before it is tried again: six hours. */
const MAX_BACKOFF_MINUTES = 360;

/**
 * How long a rule that has failed `failures` times in a row — in a way its
 * log could not record — waits before it is tried again: a minute, then
 * doubling, so a fault that lasts is not retried every minute.
 */
export function backoffMinutes(failures: number): number {
  return Math.min(2 ** Math.max(0, failures - 1), MAX_BACKOFF_MINUTES);
}

/**
 * The longest a rule waits whose Claude step could not reach Claude at all
 * (#182): asking whether it can is local and asks Claude nothing, and a
 * person who has just logged in should not wait hours for the next try.
 */
const MAX_UNAVAILABLE_BACKOFF_MINUTES = 15;

/** {@link backoffMinutes}, for a rule held back because Claude could not be reached. */
export function unavailableBackoffMinutes(failures: number): number {
  return Math.min(backoffMinutes(failures), MAX_UNAVAILABLE_BACKOFF_MINUTES);
}

/**
 * The most runs a note trigger may make in an hour (P29-01). Each save of a
 * note it watches is a new version; a rule that keeps setting itself, or
 * another rule, off is held here rather than running for ever.
 */
export const NOTE_RUNS_PER_HOUR = 20;

const HOUR_MS = 3_600_000;

/**
 * When a rule a note sets off may run again, once it has spent as much in the
 * hour up to `now` as it may; null while it may still run. A run that changed
 * a note, and a run whose query did not read (so a broken rule is held too),
 * spend one. A Claude step spends what it asked the model: one for each ask
 * (`claude.asks`) — a long meeting read in ten parts is ten, not one — and
 * nothing when it never asked (a prompt that would not read, a provider that
 * was not ready), since the model was not used (P29-03, P29-05). A run that
 * changed nothing — every note it heard already as it leaves them, or open
 * with unsaved typing — spends nothing. A run is let start while under the
 * cap, so one may take it past by its own asks (at most ten).
 *
 * A step with an hourly allowance of its own (`budget.asksPerHour`, #179)
 * counts asks against that allowance alone, and everything else the rule
 * spends against the shared runs; it is held while either is spent. The
 * allowance is one for the vault, shared by every rule whose step has it
 * (`sharesAskAllowance`): its asks are counted over `allowanceEntries`, every
 * such rule's log, and default to the rule's own.
 */
export function noteRunsHeldUntil(
  entries: readonly LogEntry[],
  now: LocalTime,
  budget: ClaudeStepBudget = SHARED_STEP_BUDGET,
  allowanceEntries: readonly LogEntry[] = entries,
): LocalTime | null {
  const end = localTimeMs(now);
  if (end === null) return null;
  const inHour = inHourUpTo(entries, end);
  const { asksPerHour } = budget;
  if (asksPerHour === null) {
    return heldUntil(
      spendTimes(inHour, (entry) => runsSpentBy(entry) + asksSpentBy(entry)),
      NOTE_RUNS_PER_HOUR,
    );
  }
  return latest(
    heldUntil(spendTimes(inHour, runsSpentBy), NOTE_RUNS_PER_HOUR),
    heldUntil(spendTimes(inHourUpTo(allowanceEntries, end), asksSpentBy), asksPerHour),
  );
}

/**
 * How many times `entries` asked Claude in the hour up to `now` (#179): what
 * a step with an allowance of its own has spent of it before a run.
 */
export function asksSpentInHour(entries: readonly LogEntry[], now: LocalTime): number {
  const end = localTimeMs(now);
  if (end === null) return 0;
  return spendTimes(inHourUpTo(entries, end), asksSpentBy).length;
}

/** The entries in the hour up to `end`, each with its moment. */
function inHourUpTo(entries: readonly LogEntry[], end: number): { at: number; entry: LogEntry }[] {
  return entries.flatMap((entry) => {
    const at = localTimeMs(entry.at);
    return at === null || at <= end - HOUR_MS || at > end ? [] : [{ at, entry }];
  });
}

/** Each spend's moment, once for each it spent, oldest first. */
function spendTimes(
  inHour: readonly { at: number; entry: LogEntry }[],
  spent: (entry: LogEntry) => number,
): number[] {
  return inHour
    .flatMap(({ at, entry }) => Array.from({ length: spent(entry) }, () => at))
    .sort((a, b) => a - b);
}

/** Until when `most` spends in the hour hold a rule back; null while fewer were spent. */
function heldUntil(times: readonly number[], most: number): LocalTime | null {
  if (times.length < most) return null;
  // Once this one is an hour old, one fewer than the most is left in the hour.
  return localTimeOf(times[times.length - most]! + HOUR_MS);
}

function latest(a: LocalTime | null, b: LocalTime | null): LocalTime | null {
  if (a === null) return b;
  return b === null || a >= b ? a : b;
}

/** What an entry asked the model: a Claude step's asks. */
function asksSpentBy(entry: LogEntry): number {
  if (entry.kind !== 'run' && entry.kind !== 'failed') return 0;
  return entry.claude?.asks ?? 0;
}

/** What an entry spent of the shared runs besides asks: a note run that changed a note, or failed. */
function runsSpentBy(entry: LogEntry): number {
  if (entry.kind !== 'run' && entry.kind !== 'failed') return 0;
  if (entry.claude !== undefined) return 0;
  if (entry.kind === 'failed') return entry.trigger === 'note' ? 1 : 0;
  return entry.trigger === 'note' && entry.done.length > 0 ? 1 : 0;
}

/** What a rule held back until `until` by {@link noteRunsHeldUntil} says. */
export function noteRunsCappedProblem(
  until: LocalTime,
  budget: ClaudeStepBudget = SHARED_STEP_BUDGET,
): string {
  const spent =
    budget.asksPerHour === null
      ? `It has used its ${NOTE_RUNS_PER_HOUR} runs, or questions put to Claude, for the last hour, the most a rule may.`
      : `Claude has been asked ${budget.asksPerHour} times in the last hour by the rules that make your own action items into tasks, the most they may together, or it has used its ${NOTE_RUNS_PER_HOUR} runs.`;
  return `${spent} It runs on what changed meanwhile at ${until.slice(11, 16)}.`;
}
