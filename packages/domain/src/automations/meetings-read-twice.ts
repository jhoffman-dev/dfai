/**
 * Two meeting presets that read the same meeting (#793): "After a meeting",
 * the declared step that summarises it and makes the owner's items tasks, and
 * "Pull actions and decisions out of a new meeting", the extraction rule.
 * With both on, Claude reads every meeting that arrives twice. That is said
 * where the rules are, with an offer to turn the extraction off; neither is
 * ever turned off without the person's click.
 */

import { MEETING_TYPE } from '../meetings/meeting-header.ts';
import type { AutomationDraft } from './automation-rule.ts';
import { isDeclaredStep } from './claude-step-budget.ts';
import { MEETING_ITEMS_OUTPUT } from './meeting-items.ts';

type RuleFacts = Pick<AutomationDraft, 'enabled' | 'action' | 'when'>;

/** Whether a rule is set off by a meeting being created. */
export function runsOnMeetingArrival({ when }: Pick<AutomationDraft, 'when'>): boolean {
  return (
    when.kind === 'note' &&
    when.type.trim().toLowerCase() === MEETING_TYPE &&
    when.on.includes('created')
  );
}

/** Whether a rule pulls a meeting's items out as proposals when it arrives, and is not the declared step. */
function extractsArrivals(rule: RuleFacts): boolean {
  const { action } = rule;
  return (
    action.kind === 'claude' &&
    !isDeclaredStep(action) &&
    action.output.kind === 'proposals' &&
    action.output.schema === MEETING_ITEMS_OUTPUT &&
    runsOnMeetingArrival(rule)
  );
}

/**
 * The extraction rules that are on beside a declared step on meeting arrival
 * that is on too — or, for the setup's preview, one about to be written
 * (`declaredComing`): each reads every meeting a second time. None when
 * either is off.
 */
export function meetingsReadTwice<Rule extends RuleFacts>(
  rules: readonly Rule[],
  { declaredComing = false }: { declaredComing?: boolean } = {},
): Rule[] {
  const declaredOn =
    declaredComing ||
    rules.some((rule) => rule.enabled && isDeclaredStep(rule.action) && runsOnMeetingArrival(rule));
  return declaredOn ? rules.filter((rule) => rule.enabled && extractsArrivals(rule)) : [];
}

/** What is said while both run: every meeting read twice, and which rule the offer turns off. */
export function meetingsReadTwiceWarning(extraction: string): string {
  return (
    `Every meeting is read twice: “After a meeting” and “${extraction}” both ask Claude about each one that arrives. ` +
    '“After a meeting” already summarises it and pulls out its action items, so you can turn the other off.'
  );
}
