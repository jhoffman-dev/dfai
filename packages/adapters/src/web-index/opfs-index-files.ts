import type { SAHPoolUtil } from '@sqlite.org/sqlite-wasm';
import type { IndexFiles } from './wasm-index-host.ts';
import { fnv1a } from './web-index-shape.ts';

/**
 * Each vault's index file in the origin's private file system (OPFS),
 * through SQLite's pool of sync access handles: the VFS that needs no
 * cross-origin isolation, so it runs on an iPad's Safari as the page is
 * served. Only the index worker opens it.
 */
export function opfsIndexFiles(pool: SAHPoolUtil): IndexFiles {
  return {
    open: (vault) => new pool.OpfsSAHPoolDb(indexFileName(vault)),
    close: (_, database) => database.close(),
    discard: (vault) => {
      // False when there was no file to throw away, which is as good.
      pool.unlink(indexFileName(vault));
    },
  };
}

/**
 * A vault's index file, named by a fingerprint of the vault rather than the
 * vault itself: a name the pool can hold whatever the vault is called, and
 * one that says nothing of it. Two FNV-1a seeds, 64 bits in all.
 */
export function indexFileName(vault: string): string {
  const part = (seed: number) => fnv1a(vault, seed).toString(16).padStart(8, '0');
  return `/index-${part(0x811c9dc5)}${part(0x050c5d1f)}.sqlite3`;
}
