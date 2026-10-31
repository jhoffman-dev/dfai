/**
 * What a rule's Claude step may spend, and which model it asks (#179).
 *
 * Every step asks at most {@link CLAUDE_ASKS_PER_RUN} times a run, and a rule
 * a note sets off spends the {@link NOTE_RUNS_PER_HOUR} runs an hour every
 * such rule has (ADR-0028). The declared step — one whose rule says
 * `apply: mine`, the "After a meeting" rule's (ADR-0036) — runs unattended on
 * every meeting, so a backlog can be many asks. It has a budget of its own:
 * at most {@link DECLARED_STEP_ASKS_PER_RUN} asks a run, its reduce asks
 * included (each planned with the parts it merges, `claudeAsks`), and an allowance of
 * {@link DECLARED_STEP_ASKS_PER_HOUR} asks an hour counted apart from the
 * shared runs, so a backlog neither spends the shared cap nor is starved by
 * it. That allowance is one for the vault, shared by every rule that says
 * `apply: mine`, and a run asks no more than the hour has left of it. It
 * asks a cheaper model, {@link DECLARED_STEP_MODEL}, unless its rule names one.
 */

import type { AutomationAction } from './automation-rule.ts';
import { CLAUDE_ASKS_PER_RUN } from './answered-note.ts';
import type { ClaudeAction } from './claude-step.ts';
import { MEETING_DIGEST_OUTPUT } from './meeting-digest.ts';
import { MEETING_ITEMS_OUTPUT } from './meeting-items.ts';

/** The most asks the declared step makes in one run, the reduce ask included. */
export const DECLARED_STEP_ASKS_PER_RUN = 10;

/** The asks the declared step may make in an hour, apart from the shared runs. */
export const DECLARED_STEP_ASKS_PER_HOUR = 30;

/** The model the declared step asks when its rule names none: Sonnet, the cheaper one. */
export const DECLARED_STEP_MODEL = 'claude-sonnet-5-5';

export interface ClaudeStepBudget {
  /** The most asks one run makes. */
  readonly asksPerRun: number;
  /**
   * The asks an hour it may make, counted apart from the shared runs and
   * shared by every step that has it (one allowance for the vault); null
   * when its asks spend the shared runs, as every other step's do.
   */
  readonly asksPerHour: number | null;
}

/** What every rule's step may spend: its asks count against the shared runs an hour. */
export const SHARED_STEP_BUDGET: ClaudeStepBudget = {
  asksPerRun: CLAUDE_ASKS_PER_RUN,
  asksPerHour: null,
};

const DECLARED_STEP_BUDGET: ClaudeStepBudget = {
  asksPerRun: DECLARED_STEP_ASKS_PER_RUN,
  asksPerHour: DECLARED_STEP_ASKS_PER_HOUR,
};

/**
 * Whether a rule's step is the declared step that post-processes meetings: a
 * Claude step that says `apply: mine` (ADR-0036), under whatever name. One
 * saved with `output: meeting-items` is read as the digest, so it counts too.
 */
export function isDeclaredStep(action: AutomationAction): boolean {
  return action.kind === 'claude' && action.apply === 'mine';
}

/**
 * Whether a rule doing `action` spends the vault's one hourly ask allowance,
 * shared by every declared step's rule (#179): its asks are counted over all
 * of their logs.
 */
export function sharesAskAllowance(action: AutomationAction): boolean {
  return claudeStepBudget(action).asksPerHour !== null;
}

/** What a rule doing `action` may spend: the declared step's own, or the shared budget. */
export function claudeStepBudget(action: AutomationAction): ClaudeStepBudget {
  return isDeclaredStep(action) ? DECLARED_STEP_BUDGET : SHARED_STEP_BUDGET;
}

/**
 * The model a step asks: the one its rule names; else Sonnet for the
 * declared step; else the chat's, as chosen in Settings → Claude.
 */
export function claudeStepModel(action: ClaudeAction, chatModel: string): string {
  return action.model ?? claudeStepDefaultModel(action) ?? chatModel;
}

/** The model a step asks when its rule names none: Sonnet for the declared step; null, the chat's. */
export function claudeStepDefaultModel(action: ClaudeAction): string | null {
  return isDeclaredStep(action) ? DECLARED_STEP_MODEL : null;
}

/**
 * The most asks a run may make when the step's allowance has had
 * `askedThisHour` asks in the hour up to it: at most its per-run budget, and
 * never past what the hour has left, so a run that starts with one ask left
 * makes one. A meeting read in parts plans its reduce out of the same asks
 * (`claudeAsks`), so a run never starts parts it cannot merge.
 */
export function claudeRunAsks(budget: ClaudeStepBudget, askedThisHour = 0): number {
  const hourLeft =
    budget.asksPerHour === null ? budget.asksPerRun : budget.asksPerHour - askedThisHour;
  return Math.max(0, Math.min(budget.asksPerRun, hourLeft));
}

/**
 * Why a run that has asked `asked` times may not ask again, or null while it
 * may: past its per-run budget, or past what the hour's allowance had left
 * when it started (`askedThisHour` asks spent).
 */
export function claudeAskRefusal(
  budget: ClaudeStepBudget,
  asked: number,
  askedThisHour = 0,
): string | null {
  const most = claudeRunAsks(budget, askedThisHour);
  if (asked < most) return null;
  if (most < budget.asksPerRun && budget.asksPerHour !== null) {
    return `It would ask Claude more than ${budget.asksPerHour} times in an hour; the rules that make your own action items into tasks ask at most ${budget.asksPerHour} an hour together.`;
  }
  return `It would ask Claude more than ${budget.asksPerRun} times; one run asks at most ${budget.asksPerRun}.`;
}

/**
 * The output a step's answer is read as: the one its rule names — except
 * that the declared step reads a meeting as a digest, its summary and its
 * items in one answer (#184, ADR-0036). A declared rule saved before the
 * digest existed names `meeting-items` (#179's preset did), and is read as
 * `meeting-digest`, so its meetings are summarised without its file being
 * written again: a rewrite would move when it was saved, and that is what
 * tells a meeting that arrived since from a backfill.
 */
export function claudeStepOutput(action: ClaudeAction): ClaudeAction['output'] {
  const { output } = action;
  return isDeclaredStep(action) &&
    output.kind === 'proposals' &&
    output.schema === MEETING_ITEMS_OUTPUT
    ? { kind: 'proposals', schema: MEETING_DIGEST_OUTPUT }
    : output;
}
