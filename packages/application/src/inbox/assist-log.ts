import {
  assistActivityReport,
  ledgerRepairedReport,
  type AssistActivity,
  type LogEntry,
  type VaultPath,
} from '@dfai/domain';
import type { ActivityLog, ActivityRecorder } from '../activity/ports.ts';
import { appendToRuleLog } from '../automations/automation-log.ts';
import type { Clock } from '../ports.ts';
import type { VaultFsPort } from '../vault/ports.ts';

/**
 * Inbox assist's own log (#909): the run log every rule keeps, under its own
 * id, so what each row applied or undid is in the vault beside what the rules
 * did. Slice 4's rule writes here too.
 */
export const INBOX_ASSIST_RULE = { id: 'inbox-assist', name: 'Inbox assist', path: null } as const;

/** What saying one apply or undo reaches. */
export interface AssistLogPorts {
  readonly fs: VaultFsPort;
  readonly clock: Pick<Clock, 'now'>;
  readonly activity: Pick<ActivityLog, 'inOpenVault'>;
}

/** A recorder for the vault open now, taken before the work waits, so its line lands in that vault's log. */
export const assistRecorder = (ports: Pick<AssistLogPorts, 'activity'>): ActivityRecorder =>
  ports.activity.inOpenVault();

/**
 * Writes `entry` to Inbox assist's log and says it in one Activity line.
 * Resolves to whether the log was written: one that cannot be is said in the
 * line, and what was done stays done — its undo does not rest on the log.
 */
export async function logAssist(
  ports: AssistLogPorts,
  {
    recorder,
    entry,
    title,
    path,
  }: { recorder: ActivityRecorder; entry: LogEntry; title: string; path: VaultPath },
): Promise<boolean> {
  const logged = await appendToRuleLog({
    fs: ports.fs,
    rule: INBOX_ASSIST_RULE,
    entry,
    now: ports.clock.now(),
    onLedgerRepaired: () => recorder.record(ledgerRepairedReport(INBOX_ASSIST_RULE)),
  }).then(
    () => true,
    // Said in the Activity line below: the notes were changed, and their undo is held apart from the log.
    () => false,
  );
  const doing = entry.kind === 'undo' ? 'undo' : 'apply';
  recorder.record(assistActivityReport({ title, path, happened: { doing, entry, logged } }));
  return logged;
}

/** Says in one Activity line that an apply or an undo did nothing, and why. */
export function sayNotDone(
  recorder: ActivityRecorder,
  { title, path, happened }: { title: string; path: VaultPath; happened: AssistActivity },
): void {
  recorder.record(assistActivityReport({ title, path, happened }));
}
