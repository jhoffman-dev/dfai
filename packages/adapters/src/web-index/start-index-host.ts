import type { SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { Clock } from '@dfai/application';
import { opfsIndexFiles } from './opfs-index-files.ts';
import { createWasmIndexHost, type WasmIndexHost } from './wasm-index-host.ts';
import type { WebIndexShape } from './web-index-shape.ts';

/** Files the pool keeps open: a database and its journal, for a few vaults. */
const POOL_CAPACITY = 8;

/**
 * The index worker's host (#666), its files in OPFS through SQLite's pool of
 * sync access handles.
 */
export async function startIndexHost({
  sqlite3,
  installPool,
  shape,
  clock,
}: {
  sqlite3: Sqlite3Static;
  /** Installs SQLite's OPFS pool: `sqlite3.installOpfsSAHPoolVfs` in the worker. */
  installPool: () => Promise<SAHPoolUtil>;
  shape: WebIndexShape;
  clock: Pick<Clock, 'now'>;
}): Promise<WasmIndexHost> {
  const pool = await installPool();
  await pool.reserveMinimumCapacity(POOL_CAPACITY);
  return createWasmIndexHost({ sqlite3, files: opfsIndexFiles(pool), shape, clock });
}
