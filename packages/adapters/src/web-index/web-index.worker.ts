import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { serveIndexHost, type IndexEndpoint } from './index-channel.ts';
import { startIndexHost } from './start-index-host.ts';
import { WEB_INDEX } from './web-index-schema.ts';

/**
 * The index worker (#666): SQLite's WebAssembly build, its files in OPFS,
 * answering the window's index calls. Nothing is loaded until the first call.
 */

serveIndexHost(self as unknown as IndexEndpoint, async () => {
  const sqlite3 = await sqlite3InitModule();
  return startIndexHost({
    sqlite3,
    installPool: () =>
      sqlite3.installOpfsSAHPoolVfs({ name: 'dfai-index', directory: '/dfai-index' }),
    shape: WEB_INDEX,
    // The worker is where the browser's clock is read: a query's deadline is kept by it.
    clock: { now: () => performance.now() },
  });
});
