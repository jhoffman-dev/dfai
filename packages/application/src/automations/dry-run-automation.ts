import {
  dryRunReport,
  messageWithoutPaths,
  type AutomationPlan,
  type AutomationRule,
  type HandledLedger,
  type LocalTime,
  type LogEntry,
  type RuleNamed,
} from '@dfai/domain';
import type { ActivityLog } from '../activity/ports.ts';
import { planRuleNow } from './note-runs.ts';
import { periodStateOf } from './period-state.ts';
import type { RuleQueryPorts } from './plan-run.ts';

/**
 * A dry run from the rule's editor (P25-03): what the rule would do today,
 * with nothing written — and a line in the Activity log saying so, or why its
 * query did not read. For a rule notes set off, the notes that would set it
 * off now: those its query matches that it has not handled as they are
 * (P29-01). Rejects as `planRun` does.
 */
export async function dryRunAutomation({
  ports,
  rule,
  log,
  ledger = null,
  named,
  today,
  at,
  activity,
}: {
  ports: RuleQueryPorts;
  /** Its `id`, once it has a file: the notes that name it are its period's. */
  rule: Pick<AutomationRule, 'when' | 'which' | 'olderThanDays' | 'action'> & {
    readonly id?: string;
  };
  /** The rule's log, for what it has handled; empty for a rule not yet saved. */
  log: readonly LogEntry[];
  /** What the rule has handled beyond its log's entries; null for a log from before the ledger. */
  ledger?: HandledLedger | null | undefined;
  /** The rule's name, and its file once it has one. */
  named: RuleNamed;
  /** `YYYY-MM-DD`, from the injected clock. */
  today: string;
  /**
   * The wall clock now, `YYYY-MM-DDTHH:MM:SS`: the period a run by hand would
   * write for. Left off, a step that writes one note a period is planned without it.
   */
  at?: LocalTime;
  activity: ActivityLog;
}): Promise<AutomationPlan> {
  // Taken before the plan waits, so its line lands in its own vault's log.
  const recorder = activity.inOpenVault();
  try {
    const target = await planRuleNow({ ports, rule, log, ledger, today });
    const plan =
      at === undefined
        ? target.plan
        : await withPeriodNote({ plan: target.plan, rule, log, at, ports });
    recorder.record(dryRunReport(named, { plan }));
    return plan;
  } catch (cause) {
    recorder.record(dryRunReport(named, { problem: messageWithoutPaths(cause) }));
    throw cause;
  }
}

/**
 * The plan with, for a step that writes one note a period, the period a run
 * by hand would write for and whether its note is made already — so the dry run
 * says what the run would do, not that there is nothing to do.
 */
export async function withPeriodNote({
  plan,
  rule,
  log,
  at,
  ports,
}: {
  plan: AutomationPlan;
  rule: Pick<AutomationRule, 'when' | 'action'> & { readonly id?: string };
  log: readonly LogEntry[];
  at: LocalTime;
  ports: RuleQueryPorts;
}): Promise<AutomationPlan> {
  // Each meeting's brief is its own period, read when the run asks (`meeting-briefs.ts`).
  if (rule.action.kind === 'claude' && rule.action.data === 'meeting-briefs') return plan;
  const state = await periodStateOf({
    rule,
    entries: log,
    at,
    trigger: 'hand',
    fs: ports.fs,
    markdown: ports.markdown,
    notePaths: ports.notePaths,
  });
  return state === null ? plan : { ...plan, periodNote: state };
}
