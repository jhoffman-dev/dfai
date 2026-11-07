import { meetingsReadTwiceWarning } from '@dfai/domain';
import type { AutomationRule } from '@dfai/domain';
import type { ReadTwiceView } from '@dfai/ui';
import type { AutomationsController } from './automations-store.ts';

/** What is said of each rule that reads every meeting a second time (#793), by name. */
export function readTwiceViews(names: readonly string[]): ReadTwiceView[] {
  return names.map((rule) => ({ rule, warning: meetingsReadTwiceWarning(rule) }));
}

/**
 * Turns the named rule off, as its toggle does, once the person clicked the
 * offer; false when the rules read hold none by that name, so nothing was.
 */
export async function turnOffRule(
  automations: AutomationsController | null,
  name: string,
): Promise<boolean> {
  const rule: AutomationRule | undefined = automations?.listing?.automations.find(
    (loaded) => loaded.rule.name === name,
  )?.rule;
  if (automations === null || rule === undefined) return false;
  await automations.setEnabled(rule, false);
  return true;
}
