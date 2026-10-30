import {
  automationEntryReport,
  automationFailedReport,
  ledgerRepairedReport,
  messageWithoutPaths,
  type LogEntry,
  type RuleNamed,
  type StoredAnswerDraft,
} from '@dfai/domain';
import type { Clock } from '../ports.ts';
import type { ActivityLog } from '../activity/ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';
import { appendToRuleLog } from './automation-log.ts';
import { ClaudeUnavailableError } from './claude-step.ts';
import { HeldForPullError } from './fresh-pull-hold.ts';
import { VaultChangedError } from './vault-guard.ts';

/**
 * Carries out a run or an undo, and says in the Activity log how it went:
 * the summary its rule's log was given, or why it stopped. A run cut off by
 * another vault opening is not the rule's failure, and the log open now is
 * that other vault's, so it is not recorded; nor is one held for the next
 * pull, which did nothing and runs again then.
 */
export async function reported<Entry extends LogEntry | null>({
  activity,
  rule,
  doing,
  carryOut,
}: {
  activity: ActivityLog;
  rule: RuleNamed;
  doing: 'run' | 'undo';
  carryOut: () => Promise<Entry>;
}): Promise<Entry> {
  // Taken before the work waits, so its line lands in its own vault's log.
  const recorder = activity.inOpenVault();
  let entry: Entry;
  try {
    entry = await carryOut();
  } catch (cause) {
    // Its failure is an entry like any other, said as the log says it; only the runner hears it as one.
    if (cause instanceof ClaudeUnavailableError) {
      const report = automationEntryReport(rule, cause.entry);
      if (report !== null) recorder.record(report);
      throw cause;
    }
    if (!(cause instanceof VaultChangedError) && !(cause instanceof HeldForPullError)) {
      recorder.record(automationFailedReport({ rule, doing, problem: messageWithoutPaths(cause) }));
    }
    throw cause;
  }
  const report = entry === null ? null : automationEntryReport(rule, entry);
  if (report !== null) recorder.record(report);
  return entry;
}

/**
 * Adds an entry to a rule's log, dated by the run's clock, and says in
 * Activity — once, as it is rebuilt — if the rule's handled ledger had to be.
 */
export function appendForRun({
  fs,
  run,
  entry,
  stored,
}: {
  fs: VaultFsPort;
  run: { rule: RuleNamed & { id: string }; clock: Pick<Clock, 'now'>; activity: ActivityLog };
  entry: LogEntry;
  /** Answers a failed run read, kept in the rule's ledger for its retry. */
  stored?: readonly StoredAnswerDraft[];
}): Promise<void> {
  // Taken before the write waits, so its line lands in its own vault's log.
  const recorder = run.activity.inOpenVault();
  return appendToRuleLog({
    fs,
    rule: run.rule,
    entry,
    ...(stored !== undefined && { stored }),
    now: run.clock.now(),
    onLedgerRepaired: () => recorder.record(ledgerRepairedReport(run.rule)),
  });
}
