// What the web build keeps of the vault on the device (#667).
export {
  cachedVaultFs,
  FOLDER_NEEDS_CONNECTION,
  NOTE_NEEDS_CONNECTION,
  revalidateKeptNotes,
  WRITE_NEEDS_CONNECTION,
} from './cached-vault-fs.ts';
export type { CachedVaultFsDeps } from './cached-vault-fs.ts';
export { keptReads } from './kept-reads.ts';
export type { KeptReads, KeptReadsDeps } from './kept-reads.ts';
export type {
  CachedRead,
  ConnectionPort,
  PendingSaveState,
  PendingSavesPort,
  ReadCacheStore,
  SaveQueueChanges,
  SaveQueueLock,
  SaveQueueStore,
} from './ports.ts';
export { AccountSwitchRefusedError, adoptAccount } from './account-switch.ts';
export { opensApp, waitsForNetwork } from './offline-session.ts';
export { offlineSaves, SAVES_CLOSED, SAVES_WAIT_FOR_ACCOUNT } from './offline-saves.ts';
export type { OfflineSaves, OfflineSavesDeps } from './offline-saves.ts';
export { signOutAndForget } from './sign-out.ts';
