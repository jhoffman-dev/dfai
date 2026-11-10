import { meetingsReadTwiceWarning, type MeetingReadTwice } from '@dfai/domain';
import type { ReadTwiceView } from '@dfai/ui';
import type { AutomationsController } from './automations-store.ts';

/** What is said of each rule that reads every meeting a second time (#793), by its file. */
export function readTwiceViews(reads: readonly MeetingReadTwice[]): ReadTwiceView[] {
  return reads.map((read) => ({
    id: read.path,
    rule: read.name,
    warning: meetingsReadTwiceWarning(read),
  }));
}

/** What a turn-off says when it could not be done; null when the rule is off now. */
export type TurnOffProblem = string | null;

/**
 * Turns the rule in this file off, as its toggle does, once the person
 * clicked the offer. Found by its file, never its name: two rules may share
 * one, and the declared step must never be the one turned off.
 */
export async function turnOffRule(
  automations: AutomationsController | null,
  path: string,
): Promise<TurnOffProblem> {
  const rule = automations?.listing?.automations.find((loaded) => loaded.rule.path === path)?.rule;
  if (automations === null || rule === undefined) {
    return 'That automation is not there any more: nothing was turned off.';
  }
  // Its runner answers a refusal (another write under way, a file changed on disk) with null.
  const done = await automations.setEnabled(rule, false);
  return done === null
    ? `“${rule.name}” was not turned off: another change was being written, or its file had changed. Try again.`
    : null;
}
