import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { IndexPort } from '@dfai/application';
import { indexHostOver, serveIndexHost, type IndexEndpoint } from './index-channel.ts';
import { memoryIndexFiles, type MemoryIndexFiles } from './memory-index-files.ts';
import { createWasmIndexHost, type WasmIndexHost } from './wasm-index-host.ts';
import { webIndexPort } from './web-index-port.ts';
import type { WebIndexShape } from './web-index-shape.ts';

/**
 * The browser's index whole but for the worker and OPFS, for Node: the same
 * host over SQLite's WebAssembly build, its files in memory, reached over a
 * real `MessageChannel`. What the tests and the work budgets run (#666).
 */
export interface InMemoryWebIndex {
  readonly index: IndexPort;
  readonly files: MemoryIndexFiles;
  /** Each host call made, by name, since the index was made. */
  readonly calls: Map<string, number>;
  /** Keeps the index's files, as a page going away does, and lets the channel go. */
  close(): void;
}

let loaded: Promise<Sqlite3Static> | null = null;

/** SQLite's WebAssembly build, loaded once for the process. */
export const sqliteWasm = (): Promise<Sqlite3Static> => (loaded ??= sqlite3InitModule());

export async function inMemoryWebIndex({
  openVault,
  files,
  shape,
}: {
  openVault: () => string | null;
  /** The tables, from the host's schema file: `WEB_INDEX` where Vite reads it, read from disk where not. */
  shape: WebIndexShape;
  /** The files of an index made before, to open again; new ones when left out. */
  files?: MemoryIndexFiles;
}): Promise<InMemoryWebIndex> {
  const sqlite3 = await sqliteWasm();
  const held = files ?? memoryIndexFiles(sqlite3);
  const calls = new Map<string, number>();
  const channel = new MessageChannel();
  serveIndexHost(channel.port1 as IndexEndpoint, async () =>
    countedHost(createWasmIndexHost({ sqlite3, files: held, shape }), calls),
  );
  channel.port1.start();
  channel.port2.start();
  const host = indexHostOver(channel.port2 as IndexEndpoint);
  return {
    index: webIndexPort({ host: () => host, openVault }),
    files: held,
    calls,
    close: () => {
      held.keep();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

function countedHost(host: WasmIndexHost, calls: Map<string, number>): WasmIndexHost {
  return Object.fromEntries(
    Object.entries(host).map(([name, call]) => [
      name,
      (...args: unknown[]) => {
        calls.set(name, (calls.get(name) ?? 0) + 1);
        return (call as (...given: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as WasmIndexHost;
}
