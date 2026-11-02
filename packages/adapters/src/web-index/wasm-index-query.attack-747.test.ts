import { beforeEach, describe, expect, it } from 'vitest';
import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { sqliteWasm } from './in-memory-web-index.ts';
import { memoryIndexFiles } from './memory-index-files.ts';
import { MAX_QUERY_BYTES } from './wasm-index-query.ts';
import { createWasmIndexHost, type WasmIndexHost } from './wasm-index-host.ts';
import { WEB_INDEX } from './web-index-schema.ts';

/**
 * Attack on PR #747 (#666): the 16 MB result cap is counted on the rows that
 * come back, after SQLite has built them, and blobs are not counted at all.
 * No SQLITE_LIMIT_LENGTH is set, so one row may build a value of up to the
 * default 1e9 bytes, and a few such values grow the worker's WebAssembly heap
 * to ~2 GB, which a heap never gives back, all in a handful of VM steps.
 */

const VAULT = 'github:example/garden';
const PAST_THE_CAP = MAX_QUERY_BYTES + 1024 * 1024;

let sqlite3: Sqlite3Static;
let host: WasmIndexHost;
beforeEach(async () => {
  sqlite3 = await sqliteWasm();
  host = createWasmIndexHost({
    sqlite3,
    files: memoryIndexFiles(sqlite3),
    shape: WEB_INDEX,
    clock: { now: () => 0 },
  });
  host.open(VAULT);
});

describe('the result cap holds for what a query builds, not only what it returns (attack #747)', () => {
  it('refuses a query that builds a text value past the cap and returns only its length', () => {
    expect(() => host.query(`SELECT length(printf('%.*c', ${PAST_THE_CAP}, 'x'))`, [])).toThrow();
  });

  it('refuses a query that builds a blob past the cap', () => {
    expect(() => host.query(`SELECT length(randomblob(${PAST_THE_CAP}))`, [])).toThrow();
  });

  it("keeps the worker's heap within a few caps after a query that builds huge values", () => {
    try {
      host.query("SELECT printf('%.*c', 400000000, 'x') = printf('%.*c', 400000000, 'y')", []);
    } catch {
      // Refusing the query is the wanted outcome; the heap is what this test checks.
    }
    expect(sqlite3.wasm.heap8u().length).toBeLessThan(8 * MAX_QUERY_BYTES);
  });
});
