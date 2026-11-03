/**
 * The browser's index (#666), an entry of its own so SQLite's WebAssembly
 * build reaches only the web build that composes it, never the desktop's.
 * The window's side alone: the host and SQLite load in the index worker
 * (`web-index.worker.ts`), on the index's first call.
 */
export { webIndex } from './web-index.ts';
export { webIndexPort } from './web-index-port.ts';
export type { IndexEndpoint, IndexHostCalls } from './index-channel.ts';
