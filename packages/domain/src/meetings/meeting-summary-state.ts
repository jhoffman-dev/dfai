/**
 * Where a meeting's summary stands (#186): what the meeting view, the Inbox,
 * the API and Claude are told. `written` while the block at the top is the
 * one Claude wrote; `edited` once the person changed it, broke its markers or
 * took it out; `pending` while the "After a meeting" rule has yet to write
 * one; `none` otherwise — no rule writes summaries, or this meeting is not
 * one it summarises.
 *
 * The rule's facts are read by the caller and handed in, so this decides
 * from what it is told and reads nothing.
 */

import type { AutomationRule } from '../automations/automation-rule.ts';
import { claudeStepOutput } from '../automations/claude-step-budget.ts';
import { MEETING_DIGEST_OUTPUT } from '../automations/meeting-digest.ts';
import type { VaultPath } from '../vault/vault-path.ts';
import { importOutcomeOf } from './meeting-arrival.ts';
import { summaryWritten, SUMMARY_DIGEST_KEY } from './meeting-summary-block.ts';
import { postProcessingFactsOf, summaryStillComing } from './post-processing-pending.ts';

export type MeetingSummaryState = 'written' | 'pending' | 'edited' | 'none';

/** The states, in the order the API documents them. */
export const MEETING_SUMMARY_STATES: readonly MeetingSummaryState[] = [
  'written',
  'pending',
  'edited',
  'none',
];

/**
 * How far back the rule that writes summaries reaches: the "After a meeting"
 * preset takes meetings of the last 14 days (`date >= @-14d`, ADR-0036). An
 * older meeting without a summary is `none`, not waiting on anything.
 */
export const SUMMARY_PENDING_DAYS = 14;

/** What the vault's summarising rule means for one meeting, as its caller read it. */
export interface SummaryStepFacts {
  /** Whether an enabled rule writes meetings' summaries ({@link writesSummaries}). */
  readonly summarising: boolean;
  /** The earliest meeting date (`YYYY-MM-DD`) it still takes; an older one is not pending. */
  readonly from: string;
  /** Whether the rule has already answered this meeting, so nothing more is coming for it. */
  readonly answered: boolean;
}

/**
 * Whether `rule` writes meetings' summaries: an enabled Claude step that says
 * `apply: mine` and whose answer is read as a `meeting-digest` — a rule saved
 * naming `meeting-items` included, since the declared step reads it so.
 */
export function writesSummaries(rule: Pick<AutomationRule, 'enabled' | 'action'>): boolean {
  const { action } = rule;
  if (!rule.enabled || action.kind !== 'claude' || action.apply !== 'mine') return false;
  const output = claudeStepOutput(action);
  return output.kind === 'proposals' && output.schema === MEETING_DIGEST_OUTPUT;
}

/**
 * Where one meeting's summary stands. A block there is `written` or `edited`
 * whatever the rule does now. With none, it is `pending` only for a meeting
 * the rule will still summarise: let in by the import (not a copy, not one
 * that failed), out of the Archive, with transcript turns to read, dated
 * within the rule's reach (or undated), and not answered yet.
 */
export function meetingSummaryState({
  path,
  body,
  properties,
  step,
}: {
  path: VaultPath;
  /** The note's body, after its frontmatter. */
  body: string;
  properties: Readonly<Record<string, unknown>>;
  step: SummaryStepFacts;
}): MeetingSummaryState {
  const recorded = properties[SUMMARY_DIGEST_KEY];
  const written = summaryWritten(body, typeof recorded === 'string' ? recorded : null);
  if (written !== 'none') return written;
  return summaryComing({ path, body, properties, step }) ? 'pending' : 'none';
}

function summaryComing({
  path,
  body,
  properties,
  step,
}: {
  path: VaultPath;
  body: string;
  properties: Readonly<Record<string, unknown>>;
  step: SummaryStepFacts;
}): boolean {
  const facts = postProcessingFactsOf({ body, properties, key: null });
  return summaryStillComing(
    {
      path,
      importOutcome: importOutcomeOf(properties),
      hasTurns: facts.hasTurns,
      date: facts.date,
    },
    step,
  );
}
