// The app shell (#656): the window, its hooks and stores, and its styles, with
// no platform in it. Each app (`apps/desktop`, `apps/web`) composes it with its
// own adapters through what is exported here, and nothing else of it.

export { mountShell, type AppPorts, type ShellComposition } from './mount-shell.tsx';

// The ports the shell's parts are built on, as a composition root fills them in.
export type { VaultPorts } from './vault/use-vault.ts';
export type { OnHost } from './vault/bound-to-vault.ts';
export type { NotePorts } from './notes/use-note.ts';
export type { IndexPorts } from './index/use-index.ts';
export type { LocalApiPorts } from './api/use-local-api.ts';
export type { SourcePorts } from './sources/source-ports.ts';
export type { ChatPorts } from './chat/use-chat.ts';
export type { BlockSyncHost } from './google-calendar/use-block-sync.ts';
export type { MeetingSyncHost } from './google-calendar/use-meeting-sync.ts';
export type { KindleHost } from './kindle/use-kindle-sync.ts';
export type { SyncHostPorts } from './sync/use-sync.ts';
export type { SemanticPorts } from './semantic/use-semantic-search.ts';

// What the shell keeps in the browser's own storage, the same on every platform.
export { browserClipboard } from './settings/clipboard.ts';
export { browserMacId } from './sync/browser-mac-id.ts';
export { browserSyncPause } from './sync/browser-sync-pause.ts';
export { browserGranolaPullRecords } from './granola/browser-granola-store.ts';
export { browserMeetingSyncRecords } from './google-calendar/browser-meeting-sync-records.ts';
export { browserBlockSyncRecords } from './google-calendar/browser-block-sync-records.ts';
export { browserKindleRecords } from './kindle/browser-kindle-records.ts';
export { browserKindleVaults } from './kindle/browser-kindle-vaults.ts';
export { browserSemanticOptIn } from './semantic/browser-semantic-opt-in.ts';
export {
  browserGlobalCaptureStore,
  type GlobalCaptureStore,
} from './global-capture/browser-global-capture-store.ts';

// The local API's hook, for the desktop's test of it on the real Tauri bridge.
export { useLocalApi } from './api/use-local-api.ts';
