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
export type { CachedRead, ConnectionPort, ReadCacheStore } from './ports.ts';
export { opensApp, waitsForNetwork } from './offline-session.ts';
export { signOutAndForget } from './sign-out.ts';
