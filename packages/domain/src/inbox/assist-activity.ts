/**
 * The one Activity line each Inbox assist apply and undo writes (#909): what
 * it did, from the entry its log was given, or why it did nothing. Names and
 * counts only, as every Activity line: never the note's words.
 */

import type { ActivityReport } from '../activity/activity-event.ts';
import { logEntrySummary, type LogEntry } from '../automations/run-log.ts';
import type { VaultPath } from '../vault/vault-path.ts';

export type AssistActivity =
  /** Applied or undone: the entry its log was given. */
  | { readonly doing: 'apply' | 'undo'; readonly entry: LogEntry; readonly logged: boolean }
  /** Not applied, or not undone, and why: nothing was left changed. */
  | { readonly doing: 'apply' | 'undo'; readonly problem: string };

export function assistActivityReport({
  title,
  path,
  happened,
}: {
  /** The item's title. */
  title: string;
  /** Where the item is now. */
  path: VaultPath;
  happened: AssistActivity;
}): ActivityReport {
  const subject = { kind: 'note' as const, path };
  if ('problem' in happened) {
    const verb = happened.doing === 'apply' ? 'could not apply' : 'could not undo';
    return {
      level: 'warning',
      kind: 'automation',
      message: `Inbox assist ${verb} “${title}”: ${happened.problem}`,
      subject,
    };
  }
  const verb = happened.doing === 'apply' ? 'applied' : 'undid';
  const unlogged = happened.logged ? '' : ' Its log could not be written.';
  return {
    level: happened.logged ? 'info' : 'warning',
    kind: 'automation',
    message: `Inbox assist ${verb} “${title}”: ${logEntrySummary(happened.entry)}${unlogged}`,
    subject,
  };
}
