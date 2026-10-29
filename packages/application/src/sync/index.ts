export { FileChangedError, ProgramMissingError } from './ports.ts';
export type {
  ConflictSide,
  GitFoldersPort,
  GitHubPort,
  GitIdentity,
  GitPort,
  GitResult,
  SleepClockPort,
  SyncFileName,
  SyncFilesPort,
  ThisMacPort,
  TreeRev,
  UnsavedWorkPort,
} from './ports.ts';
export { programWasMissing, SyncError } from './git-steps.ts';
export { createFreshPullGate } from './fresh-pull-gate.ts';
export type {
  Arrival,
  FreshPullGate,
  FreshPullGatePorts,
  FreshPullHere,
} from './fresh-pull-gate.ts';
export { syncNow } from './sync-now.ts';
export type { SyncPorts } from './sync-now.ts';
export { mergeSettings } from './merge-settings.ts';
export type { SettingsVersions } from './merge-settings.ts';
export { setUpSync } from './set-up-sync.ts';
export type { SetUpMac, SetUpSyncPorts, SyncRemoteChoice } from './set-up-sync.ts';
export { inspectSync } from './inspect-sync.ts';
export type { SyncSetup } from './inspect-sync.ts';
export { openVaultFromGitHub } from './open-from-github.ts';
export {
  automationsSettingsReading,
  loadSyncSettings,
  saveSyncSettings,
  syncSettingsOf,
} from './sync-settings.ts';
export type { SyncSettings, SyncTimingChanges } from './sync-settings.ts';
export { claimAutomations } from './claim-automations.ts';
export { automationsOnGitHub } from './automations-on-github.ts';
export type { AutomationsOnGitHub, GitHubSettingsGit } from './automations-on-github.ts';
export { checkRemote } from './check-remote.ts';
export { listGitHubRepositories } from './list-repositories.ts';
