import { archiveRefusal } from '../archive/archive.ts';
import { isProposalPath } from '../proposals/proposal.ts';
import { isAtlasNote } from '../vault/vault-visibility.ts';
import { describeNotLinked, type MeetingsNotLinked } from '../meeting-links/meeting-relink.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import { MAX_ACTIONS_PER_RUN } from './automation-query.ts';
import type { AutomationAction } from './automation-rule.ts';
import { CLAUDE_NOTES_PER_RUN, readsData } from './claude-step.ts';
import type { OutputPeriod } from './output-period.ts';

/** A note the rule matched and will not touch, and why. */
export interface PassedOver {
  readonly path: VaultPath;
  readonly reason: string;
}

/** What a rule would do now: the dry run, and what a run carries out. */
export interface AutomationPlan {
  readonly action: AutomationAction;
  /** The notes it would act on, at most {@link capFor} the action. */
  readonly paths: readonly VaultPath[];
  /** Matched, and refused by the action's own rules. */
  readonly passedOver: readonly PassedOver[];
  /**
   * It matched more than one run may do; the rest wait for the next. The
   * query asks for one more than the cap, so how many more is not known.
   */
  readonly capped: boolean;
  /**
   * For a step that writes one note a period (#40): the period a run by hand
   * would write for, and whether its note is made already. Left off by the
   * domain; the dry run says it, since it takes the log and the vault's notes.
   */
  readonly periodNote?: { readonly period: OutputPeriod; readonly made: boolean };
  /**
   * The meetings it matched whose linking failed (#192), which a run by hand
   * links again before anything else. Left off by the domain, and when there
   * are none; the dry run reads them from the meetings.
   */
  readonly notLinked?: MeetingsNotLinked;
}

/**
 * What a rule would do to the notes its query matched (P25-01). Pure: the
 * runner is handed this and only carries it out.
 *
 * A note the action cannot apply to — DFAI's own files, a note already
 * archived — is passed over and said so. Past the cap, the rest wait.
 */
export function planAutomation({
  action,
  matched,
  cap = capFor(action),
}: {
  action: AutomationAction;
  /** The query's rows' paths, in the query's order, without repeats. */
  matched: readonly VaultPath[];
  cap?: number;
}): AutomationPlan {
  const paths: VaultPath[] = [];
  const passedOver: PassedOver[] = [];
  const seen = new Set<string>();
  for (const path of matched) {
    if (seen.has(path)) continue;
    seen.add(path);
    const refusal = refusalOf(action, path);
    if (refusal === null) paths.push(path);
    else passedOver.push({ path, reason: refusal });
  }
  return {
    action,
    paths: paths.slice(0, cap),
    passedOver,
    capped: paths.length > cap,
  };
}

/**
 * The most notes one run of the action takes: a Claude step reads each one,
 * which costs a model's time, so it takes far fewer than a move does.
 */
export function capFor(action: AutomationAction): number {
  return action.kind === 'claude' ? CLAUDE_NOTES_PER_RUN : MAX_ACTIONS_PER_RUN;
}

function refusalOf(action: AutomationAction, path: VaultPath): string | null {
  if (action.kind === 'archive') return archiveRefusal(path);
  // Read, a proposal would be answered with more proposals, each setting the rule off again.
  if (action.kind === 'claude' && isProposalPath(path)) {
    return 'A Claude step does not read proposals: it would be answering itself.';
  }
  return isAtlasNote(path) ? 'DFAI keeps its own files as they are.' : null;
}

/** What a dry run of the morning brief (#39) says: which meetings it briefs is read when it runs. */
export const MEETING_BRIEFS_PLAN =
  'Would write a brief for each of today’s meetings with a linked person or company that has none yet.';

/** The plan in a sentence: "Would archive 12 notes.", then the meetings it would link again. */
export function describePlan(plan: AutomationPlan): string {
  const said = describeNotes(plan);
  if (plan.notLinked === undefined) return said;
  const relink = describeNotLinked(plan.notLinked);
  return said === NOTHING_TO_DO ? relink : `${said} ${relink}`;
}

const NOTHING_TO_DO = 'Nothing to do right now.';

function describeNotes(plan: AutomationPlan): string {
  const count = plan.paths.length;
  const notes = `${count} ${count === 1 ? 'note' : 'notes'}`;
  if (plan.periodNote?.made === true) {
    return `Its note for ${plan.periodNote.period.slot.slice(0, 10)} is made already: nothing to do right now.`;
  }
  // A step that reads its data asks with no note at all, and still writes one — a morning brief, one a meeting.
  const writes =
    count === 0 && readsData(plan.action)
      ? plan.action.kind === 'claude' && plan.action.data === 'meeting-briefs'
        ? MEETING_BRIEFS_PLAN
        : 'Would write its note.'
      : null;
  const head = writes ?? (count === 0 ? NOTHING_TO_DO : `Would ${planVerb(plan.action)} ${notes}.`);
  return plan.capped ? `${head} ${cappedLine(plan.paths.length)}` : head;
}

/** What a plan would do to its notes, as "Would … 12 notes" says it. */
export function planVerb(action: AutomationAction): string {
  if (action.kind === 'archive') return 'archive';
  return action.kind === 'set' ? 'change' : 'ask Claude about';
}

/** What a run that reached the cap says about the rest. */
export function cappedLine(cap: number): string {
  return `Stopped at ${cap}, the most one run may do; the rest wait for the next run.`;
}
