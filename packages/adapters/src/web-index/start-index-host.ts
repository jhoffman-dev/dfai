import type { SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { Clock } from '@dfai/application';
import { opfsIndexFiles } from './opfs-index-files.ts';
import { sessionIndexFiles } from './session-index-files.ts';
import { isStorageRefusal } from './storage-refusal.ts';
import { createWasmIndexHost, type IndexFiles, type WasmIndexHost } from './wasm-index-host.ts';
import type { WebIndexShape } from './web-index-shape.ts';

/** Files the pool keeps open: a database and its journal, for a few vaults. */
const POOL_CAPACITY = 8;

/**
 * The index worker's host (#666), its files in OPFS through SQLite's pool of
 * sync access handles. A browser that refuses OPFS gets an index in memory
 * for the page instead, whose every opening says it is not kept (#761);
 * any other failure is passed on.
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
  const kept = await poolFiles(installPool).catch((error: unknown) => {
    if (!isStorageRefusal(error)) throw error;
    return null;
  });
  if (kept !== null) return createWasmIndexHost({ sqlite3, files: kept, shape, clock });
  const host = createWasmIndexHost({ sqlite3, files: sessionIndexFiles(sqlite3), shape, clock });
  return { ...host, open: (vault) => ({ ...host.open(vault), kept: false }) };
}

async function poolFiles(installPool: () => Promise<SAHPoolUtil>): Promise<IndexFiles> {
  const pool = await installPool();
  await pool.reserveMinimumCapacity(POOL_CAPACITY);
  return opfsIndexFiles(pool);
}
