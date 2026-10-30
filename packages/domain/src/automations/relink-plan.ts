import type { MeetingsNotLinked } from '../meeting-links/meeting-relink.ts';
import type { AutomationAction } from './automation-rule.ts';

/**
 * Whether a rule's run by hand links its meetings again (#192): the declared
 * "After a meeting" step (`apply: mine`, #179), the one rule the pipeline of
 * ADR-0027 runs linking for.
 */
export function relinksMeetings(rule: { readonly action: AutomationAction }): boolean {
  return rule.action.kind === 'claude' && rule.action.apply === 'mine';
}

/** What a dry run says of them: "2 meetings are not linked: Run now links them first." */
export function describeNotLinked(notLinked: MeetingsNotLinked): string {
  const count = notLinked.paths.length;
  const head =
    count === 1
      ? '1 meeting is not linked: Run now links it first.'
      : `${count} meetings are not linked: Run now links them first.`;
  return notLinked.capped ? `${head} More wait for the next run.` : head;
}
