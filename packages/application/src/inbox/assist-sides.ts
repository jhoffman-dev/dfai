import type { AssistMark, LogEntry, VaultPath } from '@dfai/domain';
import type { ActivityLog, ActivityRecorder } from '../activity/ports.ts';
import type { ArchivePorts } from '../archive/archive-notes.ts';
import type { Clock } from '../ports.ts';
import { assistVault, type AssistVault } from './assist-guard.ts';
import { logAssist, logMark } from './assist-log.ts';

/** What applying an Inbox assist row reaches (#909): the Inbox's own writes, the clock, and Activity. */
export interface ApplyAssistPorts extends ArchivePorts {
  readonly clock: Pick<Clock, 'now' | 'today' | 'localNow'>;
  readonly activity: Pick<ActivityLog, 'inOpenVault'>;
}

/** Inbox assist's own log, and nothing else it can write. */
export interface AssistLog {
  /** Logs a row's mark; rejects when the log cannot be written. */
  readonly mark: (mark: AssistMark) => Promise<void>;
  /** Logs a closing entry and says it in Activity; resolves to whether the log was written. */
  readonly entry: (said: {
    recorder: ActivityRecorder;
    entry: LogEntry;
    title: string;
    path: VaultPath;
  }) => Promise<boolean>;
}

/**
 * What Inbox assist's modules hold (#911): the vault to read, a guard for
 * each row or undo — the only way to write a note — and the log. The raw
 * ports are split here, at the entry points, and go no further.
 */
export interface AssistSides {
  readonly vault: AssistVault;
  readonly log: AssistLog;
  readonly clock: ApplyAssistPorts['clock'];
  readonly activity: ApplyAssistPorts['activity'];
}

export function assistSides(ports: ApplyAssistPorts): AssistSides {
  return {
    vault: assistVault(ports),
    log: {
      mark: (mark) => logMark(ports, mark),
      entry: (said) => logAssist(ports, said),
    },
    clock: ports.clock,
    activity: ports.activity,
  };
}
