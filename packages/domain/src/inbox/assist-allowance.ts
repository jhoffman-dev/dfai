/**
 * Inbox assist spends the vault's one hourly ask allowance (#179, #899): the
 * {@link DECLARED_STEP_ASKS_PER_HOUR} asks "After a meeting" spends. The
 * preview writes no log, so its own asks are counted beside the logged ones
 * by whoever keeps them; an ask is refused while the hour has none left, and
 * said in the words a rule held by its asks is (#813).
 */

import { DECLARED_STEP_ASKS_PER_HOUR } from '../automations/claude-step-budget.ts';
import { localTimeOf } from '../automations/schedule.ts';
import type { LocalTime } from '../automations/schedule.ts';

const HOUR_MS = 3_600_000;

/** Whether one more ask fits the hour, or until when it does not. */
export type AssistAllowance =
  { readonly ok: true } | { readonly ok: false; readonly until: LocalTime };

/**
 * Whether one more ask fits in the hour up to `now`, given when the logged
 * asks and the preview's own were made; every time is a wall-clock time in
 * milliseconds, as `localTimeMs` reads one.
 */
export function assistAllowance({
  logged,
  previewed,
  now,
}: {
  logged: readonly number[];
  previewed: readonly number[];
  now: number;
}): AssistAllowance {
  const inHour = [...logged, ...previewed]
    .filter((at) => at > now - HOUR_MS && at <= now)
    .sort((a, b) => a - b);
  if (inHour.length < DECLARED_STEP_ASKS_PER_HOUR) return { ok: true };
  // Once this one is an hour old, one fewer than the most is left in the hour.
  return {
    ok: false,
    until: localTimeOf(inHour[inHour.length - DECLARED_STEP_ASKS_PER_HOUR]! + HOUR_MS),
  };
}

/** What the Inbox says while the hour's asks are spent: not broken, when it can ask again, nothing to do. */
export function assistAllowanceWords(until: LocalTime): string {
  const most = DECLARED_STEP_ASKS_PER_HOUR;
  return `Not broken: Claude has been asked ${most} times this hour, and ${most} is the most Suggest and “After a meeting” may ask together. Suggest can ask again at ${until.slice(11, 16)}; nothing to do.`;
}
