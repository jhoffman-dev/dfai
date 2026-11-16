/**
 * Two meeting presets that read the same meeting (#793): "After a meeting",
 * the declared step that summarises it and makes the owner's items tasks, and
 * "Pull actions and decisions out of a new meeting", the extraction rule.
 * With both on, Claude reads every meeting that arrives twice. That is said
 * where the rules are, with an offer to turn the extraction off; neither is
 * ever turned off without the person's click.
 */

import { MEETING_TYPE } from '../meetings/meeting-header.ts';
import { foldedTypeName } from '../types/note-type-sql.ts';
import type { AutomationDraft } from './automation-rule.ts';
import { isDeclaredStep } from './claude-step-budget.ts';
import { MEETING_ITEMS_OUTPUT } from './meeting-items.ts';
import { AFTER_A_MEETING_PRESET } from './presets.ts';

type RuleFacts = Pick<AutomationDraft, 'name' | 'enabled' | 'action' | 'when'>;

/** Whether a rule is set off by a meeting being created. */
export function runsOnMeetingArrival({ when }: Pick<AutomationDraft, 'when'>): boolean {
  return (
    when.kind === 'note' &&
    foldedTypeName(when.type) === MEETING_TYPE &&
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

/** Whether to count a declared step the setup is about to write, as its preview does. */
interface ReadTwiceOptions {
  readonly declaredComing?: boolean;
}

/**
 * The name of the declared step that reads every meeting as it arrives and
 * is on — or, for the setup's preview, the preset's, about to be written
 * (`declaredComing`). Null when none does.
 */
function declaredReader(
  rules: readonly RuleFacts[],
  { declaredComing = false }: ReadTwiceOptions,
): string | null {
  if (declaredComing) return AFTER_A_MEETING_PRESET.name;
  const on = rules.find(
    (rule) => rule.enabled && isDeclaredStep(rule.action) && runsOnMeetingArrival(rule),
  );
  return on?.name ?? null;
}

/**
 * The extraction rules that are on beside a declared step on meeting arrival
 * that is on too — or one about to be written — each reading every meeting a
 * second time. None when either is off.
 */
export function meetingsReadTwice<Rule extends RuleFacts>(
  rules: readonly Rule[],
  options: ReadTwiceOptions = {},
): Rule[] {
  if (declaredReader(rules, options) === null) return [];
  return rules.filter((rule) => rule.enabled && extractsArrivals(rule));
}

/** A rule that reads every meeting a second time, as the offer names it: its file, its name, and the rule beside it. */
export interface MeetingReadTwice {
  /** The rule's file: what the offer turns off. Names are not unique; a path is. */
  readonly path: string;
  readonly name: string;
  /** The declared step's name it reads beside, as that rule is named now. */
  readonly declared: string;
}

/** {@link meetingsReadTwice}, each with its file and the declared step it reads beside; a rule with no file is left out. */
export function meetingReadsTwice(
  rules: readonly (RuleFacts & { readonly path?: string })[],
  options: ReadTwiceOptions = {},
): MeetingReadTwice[] {
  const declared = declaredReader(rules, options);
  if (declared === null) return [];
  return meetingsReadTwice(rules, options).flatMap(({ path, name }) =>
    path === undefined ? [] : [{ path, name, declared }],
  );
}

/** What is said while both run: every meeting read twice, by which rules, and that the other can be turned off. */
export function meetingsReadTwiceWarning({
  declared,
  name,
}: Pick<MeetingReadTwice, 'declared' | 'name'>): string {
  return (
    `Every meeting is read twice: “${declared}” and “${name}” both ask Claude about each one that arrives. ` +
    `“${declared}” already summarises it and pulls out its action items, so you can turn the other off.`
  );
}
