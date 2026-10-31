import {
  DEFAULT_PULL_INTERVAL_MINUTES,
  DEFAULT_PUSH_DELAY_SECONDS,
  PULL_INTERVAL_CHOICES,
  PUSH_DELAY_CHOICES,
  suggestedRepositoryName,
  syncBadge,
  syncStanding,
  type SyncPhase,
} from '@dfai/domain';
import type { SyncSettingsView } from '@dfai/ui';
import type { SyncController } from './use-sync.ts';

/** A time as this Mac's clock shows it, to the minute. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Settings' status line, in the words for how the vault stands (the domain's order). */
function statusLine(phase: SyncPhase, facts: { behind: number; paused: boolean }): string {
  const standing = syncStanding(phase, facts);
  switch (standing?.kind) {
    case undefined:
      if (phase.kind === 'not-set-up') return 'Not set up';
      return phase.kind === 'refused' ? 'Can’t sync this vault' : 'Checking…';
    case 'syncing':
      return 'Syncing…';
    case 'paused':
      return 'Paused on this Mac';
    case 'failed':
      return `Last sync failed at ${clockTime(standing.at)}`;
    case 'behind':
      return `${standing.count} ${standing.count === 1 ? 'change' : 'changes'} from other Macs to bring in`;
    case 'not-synced-yet':
      return 'Set up';
    case 'synced':
      return `Synced at ${clockTime(standing.report.at)}`;
  }
}

function stageOf(sync: SyncController): SyncSettingsView['stage'] {
  if (sync.setup === null) return 'checking';
  return sync.setup.kind;
}

/** Settings → Sync, from how the vault's sync stands. */
export function syncSettingsView(sync: SyncController, vaultName: string): SyncSettingsView {
  const { phase, setup, behind, paused } = sync;
  const reason = phase.kind === 'failed' || phase.kind === 'refused' ? phase.reason : sync.problem;
  return {
    stage: stageOf(sync),
    statusLine: statusLine(phase, { behind, paused }),
    tone:
      syncBadge(phase, { behind, paused })?.tone ?? (phase.kind === 'refused' ? 'error' : 'quiet'),
    problem: reason,
    remote: setup?.kind === 'set-up' ? setup.remote : null,
    suggestedName: suggestedRepositoryName(vaultName),
    busy: phase.kind === 'syncing',
    pushDelaySeconds: sync.settings?.pushDelaySeconds ?? DEFAULT_PUSH_DELAY_SECONDS,
    pushDelayChoices: PUSH_DELAY_CHOICES,
    pullIntervalMinutes: sync.settings?.pullIntervalMinutes ?? DEFAULT_PULL_INTERVAL_MINUTES,
    pullIntervalChoices: PULL_INTERVAL_CHOICES,
    paused,
    thisMac: sync.thisMac ?? 'this Mac',
    automationsMac: sync.settings?.automationsMacName ?? sync.settings?.automationsMac ?? null,
    automationsHere: sync.automationsHere,
    claiming: sync.claiming,
    conflicts: phase.kind === 'synced' ? phase.report.conflicts : [],
    notSynced: phase.kind === 'synced' ? phase.report.notSynced : [],
    ignored: phase.kind === 'synced' ? phase.report.ignored : [],
    repositories: sync.repositories,
  };
}

/** The sidebar's sync light, or null for a vault that does not sync. */
export function syncIndicatorBadge(sync: Pick<SyncController, 'phase' | 'behind' | 'paused'>) {
  return syncBadge(sync.phase, { behind: sync.behind, paused: sync.paused });
}

/**
 * The window's warning after a sync that could not keep a file in one place;
 * null otherwise. Both Macs changed it, and this Mac's version stayed — or
 * the other Mac's took a name differing only in case, and this Mac's went
 * to the copy.
 */
export function syncConflictNotice(phase: SyncPhase): string | null {
  if (phase.kind !== 'synced' || phase.report.conflicts.length === 0) return null;
  const { conflicts } = phase.report;
  const [first] = conflicts;
  if (conflicts.length === 1 && first !== undefined && first.whose === 'ours') {
    return `Another Mac made ${first.path} under a name that differs only in case. Its file keeps the name; this Mac’s is saved as ${first.copy} — see Settings → Sync.`;
  }
  const what =
    conflicts.length === 1 && first !== undefined ? first.path : `${conflicts.length} files`;
  const kept = conflicts.every(({ whose }) => whose === 'theirs')
    ? 'This Mac’s version was kept; the other Mac’s is saved beside it'
    : 'Both Macs’ versions are kept';
  return `Both Macs changed ${what}. ${kept} — see Settings → Sync.`;
}
