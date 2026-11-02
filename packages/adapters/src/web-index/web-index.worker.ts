import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { serveIndexHost, type IndexEndpoint } from './index-channel.ts';
import { opfsIndexFiles } from './opfs-index-files.ts';
import { createWasmIndexHost } from './wasm-index-host.ts';
import { WEB_INDEX } from './web-index-schema.ts';

/**
 * The index worker (#666): SQLite's WebAssembly build, its files in OPFS,
 * answering the window's index calls. Nothing is loaded until the first call.
 */

/** Files the pool keeps open: a database and its journal, for a few vaults. */
const POOL_CAPACITY = 8;

serveIndexHost(self as unknown as IndexEndpoint, async () => {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: 'dfai-index',
    directory: '/dfai-index',
  });
  await pool.reserveMinimumCapacity(POOL_CAPACITY);
  // The worker is where the browser's clock is read: a query's deadline is kept by it.
  const clock = { now: () => performance.now() };
  return createWasmIndexHost({ sqlite3, files: opfsIndexFiles(pool), shape: WEB_INDEX, clock });
});
