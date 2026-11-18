import {
  appendEntryToLog,
  logPathFor,
  parentVaultPath,
  parseRunLog,
  readHandledLedger,
  type AutomationRule,
  type HandledLedger,
  type LogEntry,
  type LoggedEntry,
  type StoredAnswerDraft,
} from '@dfai/domain';
import { ensureFolder } from '../vault/create-folder.ts';
import type { VaultFsPort } from '../vault/ports.ts';

/** A rule's log as it is on disk: its text, when it was read, and its entries. */
export interface RuleLog {
  readonly text: string | null;
  readonly modified: number | null;
  readonly entries: readonly LogEntry[];
  /** What it has handled, which outlives the entries; null for a log from before the ledger. */
  readonly ledger: HandledLedger | null;
}

/**
 * A log entry that could not be written. It carries the entry, so whoever
 * started the run still knows what the run did — and can stop the rule until
 * its log can say so, rather than change more notes nothing records.
 */
export class AutomationLogError extends Error {
  constructor(
    readonly entry: LoggedEntry,
    cause: unknown,
  ) {
    super(
      `Its log could not be written (${cause instanceof Error ? cause.message : String(cause)}).`,
      { cause },
    );
    this.name = 'AutomationLogError';
  }
}

/** Reads a rule's log; an empty one when the rule has never written one. */
export async function readRuleLog(
  fs: VaultFsPort,
  rule: Pick<AutomationRule, 'id'>,
): Promise<RuleLog> {
  const [file] = await fs.readNotes([logPathFor(rule.id)]);
  if (file === undefined) return { text: null, modified: null, entries: [], ledger: null };
  return {
    text: file.text,
    modified: file.modified,
    entries: parseRunLog(file.text),
    ledger: readHandledLedger(file.text),
  };
}

/**
 * Adds an entry to a rule's log, making the log — and its folder — the first
 * time. `now` is the clock's instant, which dates what the rule's handled
 * ledger records (the entry's own time is the person's wall clock). The write
 * is refused if the log changed since it was read, rather than losing
 * whatever was added in between. When the ledger did not add up and was
 * rebuilt, `onLedgerRepaired` is told, once the log is written. Rejects with
 * {@link AutomationLogError} when it cannot be written.
 */
export async function appendToRuleLog({
  fs,
  rule,
  entry,
  now,
  onLedgerRepaired,
  stored,
}: {
  fs: VaultFsPort;
  rule: Pick<AutomationRule, 'id' | 'name'>;
  /** A rule's entry, or one of Inbox assist's marks (#911). */
  entry: LoggedEntry;
  now: number;
  onLedgerRepaired?: () => void;
  /** A Claude step's answers to keep in the ledger (ADR-0036), written in the same write. */
  stored?: readonly StoredAnswerDraft[];
}): Promise<void> {
  try {
    const path = logPathFor(rule.id);
    const log = await readRuleLog(fs, rule);
    const { text: contents, ledgerRepaired } = appendEntryToLog({
      text: log.text,
      ruleName: rule.name,
      entry,
      now,
      ...(stored !== undefined && { stored }),
    });
    if (log.text === null) {
      await ensureFolder({ fs, folder: parentVaultPath(path) });
      await fs.createNote({ path, contents });
    } else {
      await fs.writeTextFile({ path, contents, expectedModified: log.modified });
    }
    if (ledgerRepaired) onLedgerRepaired?.();
  } catch (cause) {
    throw new AutomationLogError(entry, cause);
  }
}
