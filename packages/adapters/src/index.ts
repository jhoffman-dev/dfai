// The adapters any platform can run. Those that speak to the Tauri host are
// in `@dfai/adapters/tauri` (`./tauri/index.ts`), for the desktop alone (#656).

export { staticAppInfo } from './app-info/static-app-info.ts';
export { remarkMarkdown } from './markdown/markdown-port.ts';
export {
  parseMarkdownBody,
  renderBlock,
  serializeMarkdownBody,
  RAW_BLOCK,
} from './markdown/markdown-blocks.ts';
export { webWorkerNoteDeriver } from './index/web-worker-note-deriver.ts';
export { browserIdle } from './embeddings/browser-idle.ts';
export { webWorkerNoteChunker } from './embeddings/web-worker-note-chunker.ts';
export * from './auth/index.ts';
export * from './github/index.ts';
export * from './web-cache/index.ts';
export * from './chat/index.ts';
export { gitCommands } from './sync/git-commands.ts';
export type { RunGit } from './sync/git-commands.ts';
export { browserExportFiles } from './export/browser-export-files.ts';
export type { BrowserExportFilesDeps, ZipFiles } from './export/browser-export-files.ts';
export { browserDownload } from './export/browser-download.ts';
export type { BrowserDownload, DownloadFile } from './export/browser-download.ts';
export { loadZipFiles } from './export/zip-files.ts';
export { browserExternalLinks } from './links/browser-external-links.ts';
export type { OpenWindow } from './links/browser-external-links.ts';
