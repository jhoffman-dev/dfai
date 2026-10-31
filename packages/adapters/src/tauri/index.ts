// The adapters that speak to the Tauri host, and everything else that imports
// @tauri-apps: an entry of their own (#656), so only the desktop's composition
// root imports them and the root barrel holds nothing a browser cannot run.

export { tauriAppInfo } from '../app-info/tauri-app-info.ts';
export { tauriVaultFs } from '../vault/tauri-vault-fs.ts';
export { tauriVaultPicker } from '../vault/tauri-vault-picker.ts';
export { tauriVaultStore } from '../vault/tauri-vault-store.ts';
export { tauriVaultWatch } from '../vault/tauri-vault-watch.ts';
export { tauriIndex } from '../index/tauri-index.ts';
export { tauriHttp } from '../sources/tauri-http.ts';
export { tauriSecrets } from '../sources/tauri-secrets.ts';
export { tauriSqliteSource } from '../sources/tauri-sqlite-source.ts';
export { tauriBlockCalendar } from '../google-calendar/tauri-block-calendar.ts';
export { tauriCalendarSource } from '../google-calendar/tauri-calendar-source.ts';
export { tauriGoogleCalendar } from '../google-calendar/tauri-google-calendar.ts';
export { tauriGoogleDrive } from '../google-calendar/tauri-google-drive.ts';
export { tauriExportFiles } from '../export/tauri-export-files.ts';
export { tauriPdfRenderer } from '../export/tauri-pdf-renderer.ts';
export { tauriApiBridge } from '../api/tauri-api-bridge.ts';
export { tauriApiSettings } from '../api/tauri-api-settings.ts';
export { tauriGlobalCapture } from '../global-capture/tauri-global-capture.ts';
export { tauriExternalLinks } from '../links/tauri-external-links.ts';
export { tauriActivityStore } from '../activity/tauri-activity-store.ts';
export { tauriWindowClosing } from '../activity/tauri-window-closing.ts';
export { tauriPageSnapshot } from '../artifacts/tauri-page-snapshot.ts';
export { tauriEmbeddings } from '../embeddings/tauri-embeddings.ts';
export { readCacheLoad, tauriEmbeddingCache } from '../embeddings/tauri-embedding-cache.ts';
export { MODEL_PROCESS_EVENT, tauriModelProcess } from '../chat/tauri-model-process.ts';
export type { ModelProcessPayload } from '../chat/tauri-model-process.ts';
export { tauriModelHttp } from '../chat/tauri-model-http.ts';
export {
  tauriGit,
  tauriGitFolders,
  tauriGitHub,
  tauriMacName,
  tauriSyncFiles,
} from '../sync/tauri-git.ts';
export { tauriSleepClock } from '../sync/tauri-sleep-clock.ts';
export { tauriGranola } from '../granola/tauri-granola.ts';
export { tauriSlack } from '../slack/tauri-slack.ts';
export { tauriKindleNotebook, tauriKindleSession } from '../kindle/tauri-kindle.ts';
